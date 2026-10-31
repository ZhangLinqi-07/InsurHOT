import { redirect } from "react-router";

// Existing bookmarks now open the unified news feed.
export function loader({ request }: { request: Request }) {
  const params = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  if (params.get("q")?.trim()) query.set("q", params.get("q")!.trim().slice(0, 160));
  return redirect(`/all${query.size ? "?" + query : ""}`);
}
