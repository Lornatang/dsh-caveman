import type { SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill';
/** Expose original upstream skills through the DSH provider registry. */
export declare function createSkillProvider(root: string, control?: SkillProviderControl): SkillProvider;
