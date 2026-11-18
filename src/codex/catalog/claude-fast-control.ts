import type { OcxConfig } from "../../types";
import { COMBO_NAMESPACE } from "../../combos/identifiers";
import { fastPolicyForModel } from "../../providers/service-tier";
import { decodeRoutedModelIdOrThrow } from "../../providers/slug-codec";
import { hasOcxComboAuthorship } from "./ownership";
import { catalogModelSlug, type CatalogModel, type RawEntry } from "./parsing";

const MARKER = "opencodex_claude_fast_control";
const FAST = {
  id: "priority", name: "Fast",
  description: "Fast for GPT subagents; Claude remains at standard speed",
};

/**
 * Display-only control for the fork's Claude/GPT policy. Never change provider
 * capabilities: this button conveys intent, not permission to send Claude Fast.
 * Run after all catalog normalization, including on retained rows.
 */
export function applyClaudeFastControl(
  entries: RawEntry[],
  config: Pick<OcxConfig, "providers" | "codexClaudeFastSubagentsOnly">,
  observedModels: readonly CatalogModel[] = [],
  exactComboSlugs: ReadonlySet<string> = new Set(),
): void {
  const observed = new Map<string, CatalogModel[]>();
  for (const model of observedModels) {
    const slug = catalogModelSlug(model);
    observed.set(slug, [...(observed.get(slug) ?? []), model]);
  }
  for (const entry of entries) {
    // Remove only our additions, never restore hidden old policy. The upstream
    // normalizers must remain free to revoke other tiers on retained rows.
    const raw = entry[MARKER];
    const previous = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as RawEntry : undefined;
    if (previous?.version === 1 && previous.slug === entry.slug) {
      if (previous.priority === true && Array.isArray(entry.service_tiers)) {
        const kept = entry.service_tiers.filter(tier => JSON.stringify(tier) !== JSON.stringify(FAST));
        entry.service_tiers = kept;
        if (previous.tiersAbsent === true && kept.length === 0) delete entry.service_tiers;
      }
      if (previous.fast === true && Array.isArray(entry.additional_speed_tiers)) {
        const kept = entry.additional_speed_tiers.filter(tier => tier !== "fast");
        entry.additional_speed_tiers = kept;
        if (previous.speedsAbsent === true && kept.length === 0) delete entry.additional_speed_tiers;
      }
      if (previous.defaultAbsent === true && entry.default_service_tier === null) delete entry.default_service_tier;
    }
    delete entry[MARKER];
    if (config.codexClaudeFastSubagentsOnly === false) continue;
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (exactComboSlugs.has(slug) || hasOcxComboAuthorship(entry)) continue;
    const models = observed.get(slug);
    let providerName: string;
    let modelId: string;
    if (models?.length) {
      if (models.length !== 1 || models[0].nativeAlias || models[0].provider === COMBO_NAMESPACE) continue;
      providerName = models[0].provider;
      modelId = models[0].id;
    } else {
      const slash = slug.indexOf("/");
      if (slash <= 0) continue;
      const namespace = slug.slice(0, slash);
      const owners = Object.entries(config.providers).filter(([name, p]) =>
        name === namespace || p.alias === namespace);
      if (owners.length !== 1) continue;
      const [name, provider] = owners[0];
      providerName = name;
      const requested = slug.slice(slash + 1);
      const aliases = Object.entries(provider.modelAliases ?? {}).filter(([, alias]) => alias === requested);
      if (aliases.length > 1) continue;
      try {
        modelId = aliases[0]?.[0] ?? decodeRoutedModelIdOrThrow(requested, [
          ...(provider.models ?? []), ...Object.keys(provider.modelAliases ?? {}),
          ...Object.keys(provider.modelAdapters ?? {}),
        ]);
      } catch { continue; }
    }
    if (providerName === COMBO_NAMESPACE) continue;
    const provider = config.providers[providerName];
    if (!provider || provider.disabled || !modelId.startsWith("claude-")
      || fastPolicyForModel(provider, modelId, providerName).adapter !== "anthropic") continue;
    const tiers = Array.isArray(entry.service_tiers) ? entry.service_tiers : [];
    const speeds = Array.isArray(entry.additional_speed_tiers) ? entry.additional_speed_tiers : [];
    const priority = !tiers.some(tier => tier?.id === "priority");
    const fast = !speeds.includes("fast");
    const defaultAbsent = !Object.hasOwn(entry, "default_service_tier");
    entry[MARKER] = {
      version: 1, slug, priority, fast, defaultAbsent,
      tiersAbsent: !Object.hasOwn(entry, "service_tiers"),
      speedsAbsent: !Object.hasOwn(entry, "additional_speed_tiers"),
    };
    if (priority) entry.service_tiers = [...tiers, { ...FAST }];
    if (fast) entry.additional_speed_tiers = [...speeds, "fast"];
    if (defaultAbsent) entry.default_service_tier = null;
  }
}
