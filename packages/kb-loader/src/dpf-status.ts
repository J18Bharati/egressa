/**
 * What a Data Privacy Framework list status means for `dpfCertified`.
 *
 * One closed table, used for the shipped knowledge base and for any fact a
 * repository supplies, so the same status never means two things depending on
 * who recorded it. Matching is exact after collapsing whitespace: a status
 * string this table does not know is not certified, because a vocabulary that
 * grows silently is how a lapsed certification reads as a live one.
 *
 * "Active - Re-certification under Review" is the case the table exists for.
 * The DPF list files it under Active, and the programme publishes no
 * definition of it. It is not counted as certified unless a named person has
 * accepted that uncertainty for this record (`acceptQualifiedStatus`).
 */
export type DpfStatusVerdict =
  | { certified: true; kind: 'active' }
  | { certified: boolean; kind: 'qualified' }
  | { certified: false; kind: 'inactive' | 'not-listed' | 'unrecognised' };

export const DPF_STATUS_ACTIVE = 'Active';
export const DPF_STATUS_QUALIFIED = 'Active - Re-certification under Review';
export const DPF_STATUS_NOT_LISTED = 'not-listed';

/** Lowercased, whitespace-collapsed. Case is folded because the list's own casing is not stable across its pages. */
const fold = (status: string) => status.trim().replace(/\s+/g, ' ').toLowerCase();

export function dpfStatusVerdict(observedStatus: string, accepted: boolean): DpfStatusVerdict {
  const status = fold(observedStatus);
  if (status === fold(DPF_STATUS_ACTIVE)) return { certified: true, kind: 'active' };
  if (status === fold(DPF_STATUS_QUALIFIED)) return { certified: accepted, kind: 'qualified' };
  if (status === fold(DPF_STATUS_NOT_LISTED)) return { certified: false, kind: 'not-listed' };
  // The list's inactive statuses carry a reason after the dash ("Inactive -
  // Lapse", "Inactive - Withdrawn"); every one of them means not certified,
  // which is also what the fallthrough would say, so naming them only changes
  // the task a reader is given.
  if (status === 'inactive' || status.startsWith('inactive - ')) {
    return { certified: false, kind: 'inactive' };
  }
  return { certified: false, kind: 'unrecognised' };
}
