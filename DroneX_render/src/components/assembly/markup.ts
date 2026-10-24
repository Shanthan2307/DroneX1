// Server-only: reads the front end's own index.html so the page always renders exactly the elements
// prototype/drone-assembly/src expects. Never copy the markup by hand.
import { readFileSync } from "node:fs";
import path from "node:path";

const INDEX_HTML = path.join(process.cwd(), "prototype/drone-assembly/index.html");

// The <body> of the prototype, without its <script> tag (the client component starts main.js itself).
export function extractBodyMarkup(html: string): string {
  const open = html.search(/<body[^>]*>/i);
  const close = html.search(/<\/body>/i);
  if (open < 0 || close < 0) throw new Error("prototype index.html has no <body>");
  const bodyStart = html.indexOf(">", open) + 1;
  return html.slice(bodyStart, close).replace(/<script\b[\s\S]*?<\/script>/gi, "").trim();
}

export function assemblyMarkup(): string {
  return extractBodyMarkup(readFileSync(INDEX_HTML, "utf8"));
}
