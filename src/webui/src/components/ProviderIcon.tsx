import type { SVGAttributes } from "react";
import spriteUrl from "../assets/provider-icons.svg?url";

/**
 * Pi provider id → sprite symbol id remapping. Sprite ids follow opencode's
 * `provider-icons` sheet; most Pi built-in ids match the sprite directly
 * (resolved against `KNOWN_ICON_IDS`), and only differing ids are remapped
 * here (e.g. Pi `together` ↔ sprite `togetherai`). Provider ids with neither
 * a remap nor a sprite entry (custom `models.json` providers, unknown
 * built-ins) fall back to the `synthetic` spark glyph.
 */
const PROVIDER_ID_TO_ICON: Record<string, string> = {
  fireworks: "fireworks-ai",
  "kimi-coding": "kimi-for-coding",
  "openai-codex": "openai",
  together: "togetherai",
  "vercel-ai-gateway": "vercel",
  "zai-coding-cn": "zai-coding-plan",
};

/** Sprite symbol ids present in the bundled sheet (opencode's `iconNames`). */
const KNOWN_ICON_IDS = new Set([
  "abacus",
  "302ai",
  "aihubmix",
  "alibaba",
  "alibaba-cn",
  "amazon-bedrock",
  "anthropic",
  "azure",
  "azure-cognitive-services",
  "bailing",
  "baseten",
  "berget",
  "cerebras",
  "chutes",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "cloudferro-sherlock",
  "cohere",
  "cortecs",
  "deepinfra",
  "deepseek",
  "digitalocean",
  "evroc",
  "fastrouter",
  "fireworks-ai",
  "firmware",
  "friendli",
  "github-copilot",
  "github-models",
  "gitlab",
  "google",
  "google-vertex",
  "google-vertex-anthropic",
  "groq",
  "helicone",
  "huggingface",
  "iflowcn",
  "inception",
  "inference",
  "io-net",
  "jiekou",
  "kilo",
  "kimi-for-coding",
  "kuae-cloud-coding-plan",
  "llama",
  "llmgateway",
  "lmstudio",
  "lucidquery",
  "meganova",
  "minimax",
  "minimax-cn",
  "minimax-cn-coding-plan",
  "minimax-coding-plan",
  "mistral",
  "moark",
  "modelscope",
  "moonshotai",
  "moonshotai-cn",
  "morph",
  "nano-gpt",
  "nebius",
  "nova",
  "novita-ai",
  "nvidia",
  "ollama-cloud",
  "opencode",
  "opencode-go",
  "openai",
  "openrouter",
  "ovhcloud",
  "perplexity",
  "poe",
  "privatemode-ai",
  "qihang-ai",
  "qiniu-ai",
  "requesty",
  "sap-ai-core",
  "scaleway",
  "siliconflow",
  "siliconflow-cn",
  "stackit",
  "stepfun",
  "submodel",
  "synthetic",
  "togetherai",
  "upstage",
  "v0",
  "venice",
  "vercel",
  "vivgrid",
  "vultr",
  "wandb",
  "xai",
  "xiaomi",
  "zai",
  "zai-coding-plan",
  "zenmux",
  "zhipuai",
  "zhipuai-coding-plan",
]);

export interface ProviderIconProps extends SVGAttributes<SVGSVGElement> {
  /** Pi provider id (e.g. "anthropic"). Unknown ids render the synthetic fallback. */
  id: string;
}

/**
 * Renders a provider logo from the bundled sprite (mirrors opencode's
 * `ProviderIcon`). The sprite fills with `currentColor`, so the icon inherits
 * the surrounding text color. Provider ids without a sprite entry fall back
 * to the `synthetic` spark glyph.
 */
export function ProviderIcon({ id, ...rest }: ProviderIconProps) {
  const symbol = PROVIDER_ID_TO_ICON[id] ?? (KNOWN_ICON_IDS.has(id) ? id : "synthetic");
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative provider badge; adjacent text carries the accessible name.
    <svg data-component="provider-icon" aria-hidden {...rest}>
      <use href={`${spriteUrl}#${symbol}`} />
    </svg>
  );
}
