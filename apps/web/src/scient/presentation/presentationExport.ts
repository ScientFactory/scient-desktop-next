export function presentationFileBaseName(title: string | null, fallback: string): string {
  const withoutExtension = title?.replace(/\.[^.]+$/, "") ?? fallback;
  const slug = withoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

export function markdownFenceCopySource(
  source: string,
  language: string,
  fenceMeta: string | undefined,
): string {
  const info = [language, fenceMeta?.trim()].filter(Boolean).join(" ");
  const longestRun = [...(source.match(/`{3,}/g) ?? [])].reduce(
    (maximum, run) => Math.max(maximum, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${info}\n${source.replace(/\n+$/, "")}\n${fence}\n\n`;
}

export { downloadBlob as downloadPresentationBlob } from "~/components/preview/staticImageActions";
