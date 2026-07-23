import { getSession } from "@/lib/auth/session";
import { REPORT_ASSET_BUCKET } from "@/lib/decision-reports/assets";
import { UUID_PATTERN } from "@/lib/decision-reports/persistence";
import { getServerSupabase, isLocalDemo } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await context.params;
  if (!UUID_PATTERN.test(assetId)) return new Response("Not found", { status: 404 });
  const session = await getSession();
  if (!isLocalDemo() && !session.userId) return new Response("Unauthorized", { status: 401 });
  const sb = await getServerSupabase();
  const metadata = await sb.from("report_assets").select("object_path, media_type, content_hash")
    .eq("asset_id", assetId).eq("scope_id", session.workspaceId).eq("status", "attached").maybeSingle();
  if (metadata.error || !metadata.data) return new Response("Not found", { status: 404 });
  const row = metadata.data as { object_path: string; media_type: string; content_hash: string };
  const downloaded = await sb.storage.from(REPORT_ASSET_BUCKET).download(row.object_path);
  if (downloaded.error || !downloaded.data) return new Response("Not found", { status: 404 });
  return new Response(downloaded.data, {
    headers: {
      "Content-Type": row.media_type,
      "Cache-Control": "private, max-age=60, no-transform",
      ETag: `"${row.content_hash}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
