/** Type declarations for the dependency-free index generator (plain Node JS). */
export declare const PRESET_CONFIG_KEYS: ReadonlySet<string>;

export interface PresetIndex {
  schemaVersion: number;
  updated: string;
  presets: { match: string[]; file: string }[];
}

export declare function buildIndex(dir?: string): PresetIndex;
