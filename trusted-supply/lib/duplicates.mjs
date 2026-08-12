export function findDuplicateRelations(candidate, candidates = []) {
  const fingerprint = candidate?.artifact?.fingerprint;
  if (!fingerprint) return [];
  return candidates
    .filter(other => other && other.id !== candidate.id && other.artifact?.fingerprint === fingerprint)
    .map(other => ({
      type: 'exact_content',
      candidateId: other.id,
      sourceIdentity: other.source?.identity || null,
      fingerprint,
    }))
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
}
