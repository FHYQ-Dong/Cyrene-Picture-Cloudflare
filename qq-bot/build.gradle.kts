plugins {
    kotlin("jvm") version "1.9.25"
    kotlin("plugin.serialization") version "1.9.25"
    id("net.mamoe.mirai-console") version "2.16.0"
}

group = "cloud.cyrene.qqbot"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.yaml:snakeyaml:2.2")
}

kotlin {
    jvmToolchain(17)
}

mirai {
    jvmTarget = JavaVersion.VERSION_17
}
