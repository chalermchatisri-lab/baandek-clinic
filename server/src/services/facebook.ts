import { admin } from "../lib/supabase";
import { env } from "../lib/env";

const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface SocialPostRow {
  id: string;
  message: string;
  image_url: string | null;
  link_url: string | null;
  video_url: string | null;
  status: "pending" | "posted" | "failed";
  fb_post_id: string | null;
  fb_video_id: string | null;
  error: string | null;
  created_at: string;
  posted_at: string | null;
}

export interface PublishResult {
  id: string;
  ok: boolean;
  fb_post_id?: string;
  error?: string;
  stillProcessing?: boolean;
}

export interface PublishSummary {
  checked: number;
  published: number;
  processing: number;
  failed: number;
  results: PublishResult[];
}

// Thrown when Facebook has accepted a Reel upload but hasn't finished
// transcoding it yet — this is expected and can take well past a single
// cron tick, not a failure. The row is left "pending" (with fb_video_id
// persisted) so the next tick resumes at the status-check/finish step
// instead of re-uploading.
class ReelStillProcessingError extends Error {}

function getFacebookEnv() {
  const pageId = env.fbPageId;
  const accessToken = env.fbPageToken;

  if (!pageId || !accessToken) {
    throw new Error("Missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN environment variable");
  }

  return { pageId, accessToken };
}

type GraphResponse = Record<string, unknown> & {
  error?: { message?: string; type?: string; code?: number };
};

async function graphRequest(url: string, params: URLSearchParams): Promise<GraphResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const json = (await response.json()) as GraphResponse;

  if (!response.ok || json.error) {
    const message = json.error?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }

  return json;
}

// Publishes a video as a Facebook Reel using the hosted-file upload flow:
// start (get an upload session) -> upload (point it at our public video_url)
// -> check processing status -> finish (publish). See Meta's Video Reels API.
//
// Facebook's transcoding queue can easily outlast a single HTTP request (or
// this free-tier host's proxy timeout), so this does a single status check
// per call rather than blocking in a poll loop. If the video isn't ready
// yet, it throws ReelStillProcessingError and the caller leaves the row
// "pending" (with fb_video_id now persisted) for the next cron tick to
// resume from the status-check step instead of re-uploading from scratch.
async function postVideoReelToFacebook(post: SocialPostRow): Promise<string> {
  const { pageId, accessToken } = getFacebookEnv();
  const base = new URLSearchParams({ access_token: accessToken });

  let videoId = post.fb_video_id;

  if (!videoId) {
    const start = await graphRequest(
      `${GRAPH_API_BASE}/${pageId}/video_reels`,
      new URLSearchParams({ ...Object.fromEntries(base), upload_phase: "start" })
    );
    const startedVideoId = start.video_id as string | undefined;
    const uploadUrl = start.upload_url as string | undefined;
    if (!startedVideoId || !uploadUrl) {
      throw new Error("Facebook video_reels start phase returned no video_id/upload_url");
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${accessToken}`,
        file_url: post.video_url as string,
      },
    });
    const uploadJson = (await uploadResponse.json()) as GraphResponse;
    if (!uploadResponse.ok || uploadJson.error) {
      const message = uploadJson.error?.message ?? `HTTP ${uploadResponse.status}`;
      throw new Error(`Reel upload phase failed: ${message}`);
    }

    videoId = startedVideoId;
    // Persist immediately: if this process gets killed/timed out before we
    // reach "posted" below, the next run must resume here, not re-upload.
    await admin.from("social_posts").update({ fb_video_id: videoId }).eq("id", post.id);
  }

  const statusRes = await fetch(
    `${GRAPH_API_BASE}/${videoId}?fields=status&access_token=${encodeURIComponent(accessToken)}`
  );
  const statusJson = (await statusRes.json()) as GraphResponse & {
    status?: { video_status?: string };
  };

  if (!statusRes.ok || statusJson.error) {
    const message = statusJson.error?.message ?? `HTTP ${statusRes.status}`;
    throw new Error(`Reel status check failed for video_id ${videoId}: ${message}`);
  }

  const videoStatus = statusJson.status?.video_status;

  if (videoStatus === "error") {
    throw new Error(`Facebook reported video processing error for video_id ${videoId}`);
  }
  if (videoStatus !== "ready") {
    throw new ReelStillProcessingError(
      `video_id ${videoId} still processing (status: ${videoStatus ?? "unknown"}); will retry next run`
    );
  }

  const finish = await graphRequest(
    `${GRAPH_API_BASE}/${pageId}/video_reels`,
    new URLSearchParams({
      ...Object.fromEntries(base),
      upload_phase: "finish",
      video_id: videoId,
      video_state: "PUBLISHED",
      description: post.message,
    })
  );

  if (!finish.success) {
    throw new Error("Facebook video_reels finish phase did not report success");
  }

  return videoId;
}

// Uses /video_reels when a video_url is present, /photos when an image_url
// is present (caption = message), otherwise /feed with the message and an
// optional link attachment.
async function postToFacebook(post: SocialPostRow): Promise<string> {
  if (post.video_url) {
    return postVideoReelToFacebook(post);
  }

  const { pageId, accessToken } = getFacebookEnv();

  const usePhotoEndpoint = Boolean(post.image_url);
  const endpoint = usePhotoEndpoint
    ? `${GRAPH_API_BASE}/${pageId}/photos`
    : `${GRAPH_API_BASE}/${pageId}/feed`;

  const body = new URLSearchParams({ access_token: accessToken });

  if (usePhotoEndpoint) {
    body.set("url", post.image_url as string);
    body.set("caption", post.message);
  } else {
    body.set("message", post.message);
    if (post.link_url) body.set("link", post.link_url);
  }

  const json = await graphRequest(endpoint, body);

  // /photos returns { id, post_id }; /feed returns { id }
  const fbPostId = (json.post_id as string | undefined) ?? (json.id as string | undefined);
  if (!fbPostId) {
    throw new Error("Facebook API returned no post id");
  }

  return fbPostId;
}

// Fetches all pending posts, publishes each to Facebook, and writes the
// result back to Supabase. Sequential (not parallel) to stay comfortably
// under Facebook's rate limits and keep error attribution simple.
export async function publishPendingPosts(): Promise<PublishSummary> {
  const { data: duePosts, error: fetchError } = await admin
    .from("social_posts")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (fetchError) {
    throw new Error(`Failed to fetch pending posts: ${fetchError.message}`);
  }

  const posts = (duePosts ?? []) as SocialPostRow[];
  const results: PublishResult[] = [];

  for (const post of posts) {
    try {
      const fbPostId = await postToFacebook(post);

      const { error: updateError } = await admin
        .from("social_posts")
        .update({
          status: "posted",
          fb_post_id: fbPostId,
          posted_at: new Date().toISOString(),
          error: null,
        })
        .eq("id", post.id);

      if (updateError) {
        // Posted to FB successfully but failed to record it — surface
        // this loudly since it risks a duplicate post on next run.
        results.push({
          id: post.id,
          ok: false,
          error: `Posted to FB (id ${fbPostId}) but DB update failed: ${updateError.message}`,
        });
        continue;
      }

      results.push({ id: post.id, ok: true, fb_post_id: fbPostId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (err instanceof ReelStillProcessingError) {
        // Not a failure — leave status "pending" (fb_video_id was already
        // persisted) so the next cron tick resumes the status check.
        results.push({ id: post.id, ok: false, stillProcessing: true, error: message });
        continue;
      }

      await admin.from("social_posts").update({ status: "failed", error: message }).eq("id", post.id);

      results.push({ id: post.id, ok: false, error: message });
    }
  }

  return {
    checked: posts.length,
    published: results.filter((r) => r.ok).length,
    processing: results.filter((r) => r.stillProcessing).length,
    failed: results.filter((r) => !r.ok && !r.stillProcessing).length,
    results,
  };
}
