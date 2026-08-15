export function parseDieZhangbi(val) {
  if (!val || !String(val).includes(':')) return { die: null, zhang: null };
  const [d, z] = String(val).split(':');
  return { die: parseInt(d, 10) || 0, zhang: parseInt(z, 10) || 0 };
}

export function buildDieZhangbi(die, zhang) {
  if (die === '' || die === null || die === undefined || zhang === '' || zhang === null || zhang === undefined) return '';
  return `${die}:${zhang}`;
}