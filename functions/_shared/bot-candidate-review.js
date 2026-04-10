import {
	getBotCandidateById,
	normalizeTagsInput,
	reviewBotCandidate,
} from "./db.js";
import { ingestRemoteImageToLibrary } from "./bot-ingest.js";
import { ErrorCode } from "./errors.js";

export async function approveBotCandidate({
	context,
	candidateId,
	manualTags = [],
	reason = "approved-by-admin",
}) {
	const { env, waitUntil } = context;
	const candidate = await getBotCandidateById(env.DB, candidateId);
	if (!candidate) {
		return {
			ok: false,
			errorCode: ErrorCode.ObjectNotFound,
			message: "candidate not found",
		};
	}
	if (candidate.status !== "pending") {
		return {
			ok: false,
			errorCode: ErrorCode.InvalidRequest,
			message: "candidate is not pending",
			candidate,
		};
	}

	const defaultTags = normalizeTagsInput(candidate.default_tags || []);
	const normalizedManualTags = normalizeTagsInput(manualTags || []);
	const finalTags = normalizeTagsInput([
		...defaultTags,
		...normalizedManualTags,
	]);
	const sourceBatchId = `qq:${candidate.group_id}:${candidate.message_id}`;
	const sourceClientFileId = String(
		candidate?.meta?.clientFileId || candidate.candidate_id
	).trim();

	const ingestResult = await ingestRemoteImageToLibrary({
		env,
		config: context.config,
		waitUntil,
		imageUrl: candidate.image_url,
		fileName: candidate?.meta?.fileName || "qq-image.jpg",
		itemMime: candidate?.meta?.mime || "",
		uploaderNickname:
			candidate?.meta?.uploaderNickname ||
			candidate.sender_id ||
			context.config.defaultUploaderNickname,
		tags: finalTags,
		sourceBatchId,
		sourceClientFileId,
	});

	if (!ingestResult.ok) {
		return ingestResult;
	}

	const updated = await reviewBotCandidate(env.DB, {
		candidateId,
		status: "approved",
		reason,
		manualTags: normalizedManualTags,
		finalTags,
		meta: {
			...candidate.meta,
			approvedImageId: ingestResult.imageId,
			approvedObjectId: ingestResult.objectId,
			dedupHit: ingestResult.dedupHit,
		},
	});
	if (!updated) {
		return {
			ok: false,
			errorCode: ErrorCode.InternalError,
			message: "failed to update candidate review status",
		};
	}

	return {
		ok: true,
		candidateId,
		status: "approved",
		manualTags: normalizedManualTags,
		finalTags,
		imageId: ingestResult.imageId,
		objectId: ingestResult.objectId,
		dedupHit: ingestResult.dedupHit,
	};
}

export async function rejectBotCandidate({ candidateId, env, reason = "" }) {
	const candidate = await getBotCandidateById(env.DB, candidateId);
	if (!candidate) {
		return {
			ok: false,
			errorCode: ErrorCode.ObjectNotFound,
			message: "candidate not found",
		};
	}
	if (candidate.status !== "pending") {
		return {
			ok: false,
			errorCode: ErrorCode.InvalidRequest,
			message: "candidate is not pending",
			candidate,
		};
	}

	const updated = await reviewBotCandidate(env.DB, {
		candidateId,
		status: "rejected",
		reason:
			String(reason || "rejected-by-admin").trim() || "rejected-by-admin",
		manualTags: [],
		finalTags: candidate.default_tags || [],
	});

	if (!updated) {
		return {
			ok: false,
			errorCode: ErrorCode.InternalError,
			message: "failed to update candidate review status",
		};
	}

	return {
		ok: true,
		candidateId,
		status: "rejected",
	};
}
