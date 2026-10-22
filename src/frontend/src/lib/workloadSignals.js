export function workloadSignalIdentity(signal) {
  const type = signal?.medium || signal?.kind;
  const id = type === 'chat'
    ? (signal?.chat_id || signal?.id || signal?.ref_id)
    : (signal?.id || signal?.ref_id);
  if (!type || !id) throw new Error('The selected communication has no stable identity.');
  return { type, id: String(id) };
}
