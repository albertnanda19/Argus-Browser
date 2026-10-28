import { researchResultSchema, type ResearchResult } from "../shared/research";

export type ResearchResultStore = {
  get(taskId: string): ResearchResult;
};

export function createResearchResultStore(): ResearchResultStore {
  const results = new Map<string, ResearchResult>();

  return {
    get(taskId) {
      const existing = results.get(taskId);
      if (existing !== undefined) {
        return structuredClone(existing);
      }

      const result = researchResultSchema.parse({ taskId, contacts: [], chain: [] });
      results.set(taskId, result);
      return structuredClone(result);
    },
  };
}
