import { createHash } from "node:crypto";

export function marketFixture() {
  const id = "example/research/market-test";
  const commit = "1234567890abcdef1234567890abcdef12345678";
  const content = "---\nname: market-test\ndescription: Reproducible research workflows.\n---\n# Research\n\nRead references/guide.md and run scripts/check.py.\n";
  const files = new Map([
    ["SKILL.md", Buffer.from(content)],
    ["references/guide.md", Buffer.from("# Evidence\nPreserve provenance.\n")],
    ["assets/sample.bin", Buffer.from([0, 255, 128, 1, 2])],
    ["scripts/check.py", Buffer.from("print('fixture')\n")],
  ]);
  const skill = { id, source: "example/research", skillId: "market-test", name: "market-test", installs: 5432 };
  const tree = [...files].map(([path, bytes]) => ({
    path: `skills/market-test/${path}`, type: "blob", mode: path.endsWith(".py") ? "100755" : "100644", size: bytes.length,
    sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
  }));
  const requests: string[] = [];
  const response = (url: string): Response => {
    requests.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === "skills.sh") {
      if (parsed.pathname === "/api/search") return Response.json({ skills: [skill] });
      const payload = `1:["$","$L1",null,${JSON.stringify({ initialSkills: [skill] })}]`;
      return new Response(`<html><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></html>`);
    }
    if (parsed.pathname.endsWith("/commits/HEAD")) return Response.json({ sha: commit });
    if (parsed.pathname.includes("/git/trees/")) return Response.json({ truncated: false, tree });
    const key = decodeURIComponent(parsed.pathname.split("/skills/market-test/")[1] ?? "");
    const bytes = files.get(key);
    return bytes ? new Response(new Uint8Array(bytes)) : new Response("Missing", { status: 404 });
  };
  return { id, commit, content, files, skill, tree, requests, response };
}
