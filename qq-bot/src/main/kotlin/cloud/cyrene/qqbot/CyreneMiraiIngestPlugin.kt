package cloud.cyrene.qqbot

import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import net.mamoe.mirai.console.plugin.jvm.JavaPlugin
import net.mamoe.mirai.console.plugin.jvm.JvmPluginDescriptionBuilder
import net.mamoe.mirai.event.GlobalEventChannel
import net.mamoe.mirai.event.events.GroupMessageEvent
import net.mamoe.mirai.message.data.Image
import net.mamoe.mirai.message.data.contentToString
import net.mamoe.mirai.message.data.filterIsInstance
import org.yaml.snakeyaml.Yaml
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration

object CyreneMiraiIngestPlugin : JavaPlugin(
    JvmPluginDescriptionBuilder("cloud.cyrene.qqbot.mirai-ingest", "0.1.0") {
        name("cyrene-mirai-ingest")
        author("Cyrene")
        info("Mirai plugin that ingests QQ group images into Cyrene API.")
    }.build()
) {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    @Volatile
    private var runtimeConfig: PluginConfig = PluginConfig()

    override fun onEnable() {
        runtimeConfig = loadPluginConfig()
        logger.info("plugin enabled, source=${runtimeConfig.plugin.source}, reviewMode=${runtimeConfig.cyrene.reviewMode}")
        if (runtimeConfig.cyrene.botIngestToken.isBlank()) {
            logger.warning("botIngestToken is empty, plugin will ignore ingest requests until configured")
        }

        GlobalEventChannel.parentScope(this).subscribeAlways<GroupMessageEvent> { event ->
            handleGroupMessage(event)
        }
    }

    private suspend fun handleGroupMessage(event: GroupMessageEvent) {
        val config = runtimeConfig
        val groupId = event.group.id.toString()
        val messageText = event.message.contentToString().trim()

        if (!isGroupAllowed(config, groupId)) return
        if (!isTriggered(config, messageText)) return

        val imageItems = event.message
            .filterIsInstance<Image>()
            .mapIndexedNotNull { index, image ->
                val imageUrl = runCatching { image.queryUrl() }.getOrNull().orEmpty().trim()
                if (imageUrl.isBlank()) return@mapIndexedNotNull null
                IngestImageItem(
                    clientFileId = "img-$index",
                    imageUrl = imageUrl,
                    fileName = "group-${groupId}-$index.jpg",
                    mime = "image/jpeg",
                    tags = emptyList()
                )
            }

        if (imageItems.isEmpty()) return

        val payload = IngestPayload(
            source = config.plugin.source,
            groupId = groupId,
            messageId = event.source.ids.joinToString("-") { it.toString() },
            senderId = event.sender.id.toString(),
            senderName = event.senderName,
            reviewMode = normalizeReviewMode(config.cyrene.reviewMode),
            tags = config.cyrene.defaultTags,
            images = imageItems
        )

        postWithRetry(config, payload)
    }

    private suspend fun postWithRetry(config: PluginConfig, payload: IngestPayload) {
        if (config.cyrene.botIngestToken.isBlank()) return
        val url = buildIngestUrl(config.cyrene.apiBaseUrl, config.cyrene.ingestPath)
        val requestBody = json.encodeToString(payload)

        val maxAttempts = (config.request.retryCount + 1).coerceAtLeast(1)
        var lastError: String = ""

        repeat(maxAttempts) { attempt ->
            val timeout = config.request.timeoutMs.coerceAtLeast(1000)
            val request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofMillis(timeout.toLong()))
                .header("content-type", "application/json")
                .header("authorization", "Bearer ${config.cyrene.botIngestToken}")
                .POST(HttpRequest.BodyPublishers.ofString(requestBody, StandardCharsets.UTF_8))
                .build()

            val response = runCatching {
                httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
            }.getOrElse { error ->
                lastError = error.message ?: error::class.simpleName.orEmpty()
                null
            }

            if (response != null) {
                val statusCode = response.statusCode()
                val body = response.body().orEmpty()
                if (statusCode in 200..299 && body.contains("\"ok\":true")) {
                    logger.info("ingest success status=$statusCode")
                    return
                }
                lastError = "status=$statusCode body=${body.take(300)}"
            }

            if (attempt + 1 < maxAttempts) {
                val backoff = config.request.retryBackoffMs.coerceAtLeast(100)
                delay((backoff * (attempt + 1)).toLong())
            }
        }

        logger.warning("ingest failed after retries: $lastError")
    }

    private fun loadPluginConfig(): PluginConfig {
        val candidates = listOf(
            Path.of("/app/config/cyrene-plugin-config.yml"),
            Path.of("config/cyrene-plugin-config.yml"),
            Path.of("config/plugin-config.yml")
        )

        val file = candidates.firstOrNull { Files.exists(it) && Files.isRegularFile(it) }
            ?: return PluginConfig()

        val text = runCatching { Files.readString(file, StandardCharsets.UTF_8) }
            .getOrElse {
                logger.warning("failed to read config file: $file")
                return PluginConfig()
            }

        return parseConfigYaml(text)
    }

    @Suppress("UNCHECKED_CAST")
    private fun parseConfigYaml(text: String): PluginConfig {
        val root = runCatching { Yaml().load<Map<String, Any?>>(text) }
            .getOrNull()
            ?: return PluginConfig()

        fun map(node: Any?): Map<String, Any?> = node as? Map<String, Any?> ?: emptyMap()
        fun string(node: Any?, fallback: String): String = node?.toString()?.trim().takeUnless { it.isNullOrBlank() } ?: fallback
        fun int(node: Any?, fallback: Int): Int = node?.toString()?.toIntOrNull() ?: fallback
        fun stringList(node: Any?): List<String> {
            if (node !is List<*>) return emptyList()
            return node.mapNotNull { it?.toString()?.trim() }.filter { it.isNotBlank() }
        }

        val pluginMap = map(root["plugin"])
        val cyreneMap = map(root["cyrene"])
        val filtersMap = map(root["filters"])
        val requestMap = map(root["request"])

        return PluginConfig(
            plugin = PluginSection(
                name = string(pluginMap["name"], "cyrene-mirai-ingest"),
                source = string(pluginMap["source"], "mirai-docker")
            ),
            cyrene = CyreneSection(
                apiBaseUrl = string(cyreneMap["apiBaseUrl"], "http://127.0.0.1:8788"),
                ingestPath = string(cyreneMap["ingestPath"], "/api/bot/ingest-images"),
                botIngestToken = string(cyreneMap["botIngestToken"], ""),
                reviewMode = string(cyreneMap["reviewMode"], "pending"),
                defaultTags = stringList(cyreneMap["defaultTags"]).ifEmpty { listOf("昔涟美图", "qq投稿") }
            ),
            filters = FilterSection(
                allowedGroups = stringList(filtersMap["allowedGroups"]),
                triggerWords = stringList(filtersMap["triggerWords"])
            ),
            request = RequestSection(
                timeoutMs = int(requestMap["timeoutMs"], 20000),
                retryCount = int(requestMap["retryCount"], 3),
                retryBackoffMs = int(requestMap["retryBackoffMs"], 800)
            )
        )
    }

    private fun isGroupAllowed(config: PluginConfig, groupId: String): Boolean {
        val allowed = config.filters.allowedGroups
        return allowed.isEmpty() || allowed.contains(groupId)
    }

    private fun isTriggered(config: PluginConfig, content: String): Boolean {
        val triggers = config.filters.triggerWords
        if (triggers.isEmpty()) return true
        val text = content.lowercase()
        return triggers.any { text.contains(it.lowercase()) }
    }

    private fun buildIngestUrl(apiBaseUrl: String, ingestPath: String): String {
        val base = apiBaseUrl.trim().trimEnd('/')
        val path = if (ingestPath.startsWith('/')) ingestPath else "/$ingestPath"
        return "$base$path"
    }

    private fun normalizeReviewMode(input: String): String {
        return if (input.trim().equals("auto", ignoreCase = true)) "auto" else "pending"
    }
}

@Serializable
data class IngestImageItem(
    val clientFileId: String,
    val imageUrl: String,
    val fileName: String,
    val mime: String,
    val tags: List<String>
)

@Serializable
data class IngestPayload(
    val source: String,
    val groupId: String,
    val messageId: String,
    val senderId: String,
    val senderName: String,
    val reviewMode: String,
    val tags: List<String>,
    val images: List<IngestImageItem>
)

data class PluginConfig(
    val plugin: PluginSection = PluginSection(),
    val cyrene: CyreneSection = CyreneSection(),
    val filters: FilterSection = FilterSection(),
    val request: RequestSection = RequestSection()
)

data class PluginSection(
    val name: String = "cyrene-mirai-ingest",
    val source: String = "mirai-docker"
)

data class CyreneSection(
    val apiBaseUrl: String = "http://127.0.0.1:8788",
    val ingestPath: String = "/api/bot/ingest-images",
    val botIngestToken: String = "",
    val reviewMode: String = "pending",
    val defaultTags: List<String> = listOf("昔涟美图", "qq投稿")
)

data class FilterSection(
    val allowedGroups: List<String> = emptyList(),
    val triggerWords: List<String> = listOf("投稿", "cyrene", "#昔涟美图")
)

data class RequestSection(
    val timeoutMs: Int = 20000,
    val retryCount: Int = 3,
    val retryBackoffMs: Int = 800
)
