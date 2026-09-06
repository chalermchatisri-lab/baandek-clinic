import { admin } from "../lib/supabase";
import { env } from "../lib/env";

const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface SocialPostRow {
  id: string;
  message: string;
  image_url: string | null;
  link_url: string | null;
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

// Uses /photos when an image_url is present (caption = message), otherwise
// /feed with the message and an optional link attachment.
async function postToFacebook(post: SocialPostRow): Promise<string> {
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

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = (await response.json()) as {
    id?: string;
    post_id?: string;
    error?: { message?: string; type?: string; code?: number };
  };

  if (!response.ok || json.error) {
    const message = json.error?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }

  // /photos returns { id, post_id }; /feed returns { id }
  const fbPostId = json.post_id ?? json.id;
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
