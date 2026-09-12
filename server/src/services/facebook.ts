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
  error: string | null;
  created_at: string;
  posted_at: string | null;
}

export interface PublishResult {
  id: string;
  ok: boolean;
  fb_post_id?: string;
  error?: string;
}

export interface PublishSummary {
  checked: number;
  published: number;
  failed: number;
  results: PublishResult[];
}

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
// -> poll processing status -> finish (publish). See Meta's Video Reels API.
async function postVideoReelToFacebook(post: SocialPostRow): Promise<string> {
  const { pageId, accessToken } = getFacebookEnv();
  const base = new URLSearchParams({ access_token: accessToken });

  const start = await graphRequest(
    `${GRAPH_API_BASE}/${pageId}/video_reels`,
    new URLSearchParams({ ...Object.fromEntries(base), upload_phase: "start" })
  );
  const videoId = start.video_id as string | undefined;
  const uploadUrl = start.upload_url as string | undefined;
  if (!videoId || !uploadUrl) {
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

  // Facebook processes the uploaded video asynchronously; poll until it's
  // ready (or errored) before asking to publish it.
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    const statusRes = await fetch(
      `${GRAPH_API_BASE}/${videoId}?fields=status&access_token=${encodeURIComponent(accessToken)}`
    );
    const statusJson = (await statusRes.json()) as GraphResponse & {
      status?: { video_status?: string; uploading_phase?: { status?: string }; processing_phase?: { status?: string } };
    };
    const videoStatus = statusJson.status?.video_status;

    if (videoStatus === "ready") break;
    if (videoStatus === "error") {
      throw new Error(`Facebook reported video processing error for video_id ${videoId}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for Facebook to finish processing video_id ${videoId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
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

      await admin.from("social_posts").update({ status: "failed", error: message }).eq("id", post.id);

      results.push({ id: post.id, ok: false, error: message });
    }
  }

  return {
    checked: posts.length,
    published: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
