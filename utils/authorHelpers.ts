import { Directory, File, Paths } from 'expo-file-system';

export interface ProjectMeta {
  beneficiaryCode: string;
  originalCode: string;
  authorId?: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReportMeta {
  reportId: string;
  beneficiaryCode: string;
  authorId?: string;
  authorName: string;
  originalAuthorId?: string;
  originalAuthorName?: string;
  isEditedCopy?: boolean;
  parentReportId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OwnershipContext {
  currentAuthorId?: string | null;
  currentUserId?: string | null;
  currentOfficialName?: string | null;
  currentUserName?: string | null;
}

export interface RecordAuthorInfo {
  authorId?: string | null;
  authorName?: string | null;
}

/**
 * Derives a compact, normalized `authorId` from an email or identifier.
 * Strips `@gmail.com` when present; otherwise returns the trimmed lowercase email.
 */
export const deriveAuthorId = (emailOrId?: string | null): string => {
  if (!emailOrId) return '';
  const normalized = emailOrId.trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.endsWith('@gmail.com')) {
    return normalized.slice(0, -'@gmail.com'.length);
  }
  return normalized;
};

/**
 * Checks whether a project or report belongs to the currently signed-in local user.
 * Uses `authorId` when available and gracefully falls back to case-insensitive
 * `authorName` / `officialName` matching for legacy records that lack `author_id`.
 */
export const isOwnedByCurrentUser = (
  record: RecordAuthorInfo,
  ctx: OwnershipContext
): boolean => {
  const recordAuthorId = deriveAuthorId(record.authorId);
  const currentAuthorId = deriveAuthorId(ctx.currentAuthorId || ctx.currentUserId);

  if (recordAuthorId && currentAuthorId) {
    return recordAuthorId === currentAuthorId;
  }

  const recordName = (record.authorName || '').trim().toLowerCase();
  if (!recordName) {
    return !recordAuthorId;
  }
  if (recordName === 'unassigned') {
    return false;
  }

  const candidates = new Set<string>();
  const pushCandidate = (val?: string | null) => {
    const clean = (val || '').trim().toLowerCase();
    if (clean) candidates.add(clean);
  };

  pushCandidate(ctx.currentOfficialName);
  pushCandidate(ctx.currentUserName);
  if (ctx.currentOfficialName || ctx.currentUserName) {
    pushCandidate(resolveAuthorName(ctx.currentOfficialName, ctx.currentUserName));
  }
  if (ctx.currentUserName) {
    pushCandidate(formatAgentName(ctx.currentUserName));
  }
  if (ctx.currentUserId) {
    pushCandidate(formatAgentName(ctx.currentUserId));
    pushCandidate(deriveAuthorId(ctx.currentUserId));
  }

  return candidates.has(recordName);
};

/**
 * Strips `@...` domain suffixes, replaces `.` and `_` with spaces,
 * and formats the result in Title Case (e.g. `john.doe@org.in` -> `John Doe`).
 */
export const formatAgentName = (rawName?: string | null): string => {
  if (!rawName) return 'Field Agent';
  const stripped = rawName.split('@')[0] ?? '';
  const cleaned = stripped.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Field Agent';
  return cleaned
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

/**
 * Resolves the effective author name using locked `officialName` first,
 * falling back to formatted `userName`.
 */
export const resolveAuthorName = (
  officialName?: string | null,
  userName?: string | null
): string => {
  if (officialName && officialName.trim().length > 0) {
    return officialName.trim();
  }
  if (userName && userName.trim().length > 0 && !userName.includes('@')) {
    return userName.trim();
  }
  return formatAgentName(userName);
};

export const getSafeCodeDirName = (code: string): string =>
  code.replace(/[\\/:*?"<>|]/g, '_') || 'NO_CODE';

export const getProjectDirectory = (code: string): Directory =>
  new Directory(Paths.document, 'HousingInspection', getSafeCodeDirName(code));

export const getReportDirectory = (code: string, reportId: string): Directory =>
  new Directory(getProjectDirectory(code), getSafeCodeDirName(reportId));

export const generateReportId = (seed?: string): string => {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  if (!seed) return `rpt_${ts}_${rand}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `rpt_${ts}_${(hash >>> 0).toString(36).slice(0, 4)}`;
};

/**
 * Reads `.project_meta.json` from a project directory if present and valid.
 */
export const readProjectMeta = async (projectDir: Directory): Promise<ProjectMeta | null> => {
  try {
    const metaFile = new File(projectDir, '.project_meta.json');
    if (!metaFile.exists) return null;
    const raw = await metaFile.text();
    const parsed = JSON.parse(raw) as Partial<ProjectMeta>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      beneficiaryCode: parsed.beneficiaryCode || '',
      originalCode: parsed.originalCode || parsed.beneficiaryCode || '',
      authorId: parsed.authorId || '',
      authorName: parsed.authorName || '',
      createdAt: parsed.createdAt || '',
      updatedAt: parsed.updatedAt || '',
    };
  } catch {
    return null;
  }
};

/**
 * Writes `.project_meta.json` inside `Paths.document/HousingInspection/<safeCodeDir>/`.
 * Preserves existing original creator metadata (`authorId` / `authorName` / `createdAt`)
 * unless explicitly missing.
 */
export const writeProjectMeta = async (
  projectDir: Directory,
  params: {
    beneficiaryCode: string;
    originalCode?: string | null;
    authorId?: string | null;
    authorName: string;
    createdAt?: string | null;
    updatedAt?: string | null;
    preserveExistingOwner?: boolean;
  }
): Promise<ProjectMeta> => {
  projectDir.create({ intermediates: true, idempotent: true });
  const existing = await readProjectMeta(projectDir);
  const nowIso = new Date().toISOString();
  const preserve = params.preserveExistingOwner !== false;

  const existingAuthorName = existing?.authorName?.trim() || '';
  const existingAuthorId = existing?.authorId?.trim() || '';
  const incomingAuthorId = params.authorId?.trim() || '';
  const incomingAuthorName = params.authorName?.trim() || '';

  const meta: ProjectMeta = {
    beneficiaryCode: params.beneficiaryCode,
    originalCode: existing?.originalCode || params.originalCode || params.beneficiaryCode,
    authorId: preserve && existingAuthorId ? existingAuthorId : (incomingAuthorId || existingAuthorId || undefined),
    authorName: preserve && existingAuthorName ? existingAuthorName : (incomingAuthorName || existingAuthorName || 'Field Agent'),
    createdAt: (preserve && existing?.createdAt) || params.createdAt || existing?.createdAt || nowIso,
    updatedAt: params.updatedAt || nowIso,
  };

  const metaFile = new File(projectDir, '.project_meta.json');
  metaFile.write(JSON.stringify(meta, null, 2));
  return meta;
};

/**
 * Reads `.report_meta.json` from a report subdirectory if present and valid.
 */
export const readReportMeta = async (reportDir: Directory): Promise<ReportMeta | null> => {
  try {
    const metaFile = new File(reportDir, '.report_meta.json');
    if (!metaFile.exists) return null;
    const raw = await metaFile.text();
    const parsed = JSON.parse(raw) as Partial<ReportMeta>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      reportId: parsed.reportId || reportDir.name,
      beneficiaryCode: parsed.beneficiaryCode || '',
      authorId: parsed.authorId || '',
      authorName: parsed.authorName || '',
      originalAuthorId: parsed.originalAuthorId || '',
      originalAuthorName: parsed.originalAuthorName || '',
      isEditedCopy: Boolean(parsed.isEditedCopy),
      parentReportId: parsed.parentReportId || '',
      createdAt: parsed.createdAt || '',
      updatedAt: parsed.updatedAt || '',
    };
  } catch {
    return null;
  }
};

/**
 * Writes `.report_meta.json` inside `HousingInspection/<safeCodeDir>/<reportId>/`.
 */
export const writeReportMeta = async (
  reportDir: Directory,
  meta: ReportMeta
): Promise<ReportMeta> => {
  reportDir.create({ intermediates: true, idempotent: true });
  const metaFile = new File(reportDir, '.report_meta.json');
  metaFile.write(JSON.stringify(meta, null, 2));
  return meta;
};

const parseFlexibleDate = (rawDate?: string | null): Date | null => {
  if (!rawDate) return null;
  const normalized = rawDate.includes('T') || rawDate.includes('Z')
    ? rawDate
    : rawDate.replace(' ', 'T') + 'Z';
  let date = new Date(normalized);
  if (isNaN(date.getTime())) {
    date = new Date(rawDate);
  }
  return isNaN(date.getTime()) ? null : date;
};

/**
 * Formats an ISO or SQLite timestamp cleanly as `DD MMM YYYY, hh:mm A`.
 */
export const formatDisplayDateTime = (rawDate?: string | null): string => {
  if (!rawDate) return 'Not recorded yet';
  const date = parseFlexibleDate(rawDate);
  if (!date) return rawDate;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(date.getDate()).padStart(2, '0');
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  const hours24 = date.getHours();
  const hours12 = String(hours24 % 12 || 12).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  return `${day} ${month} ${year}, ${hours12}:${minutes} ${ampm}`;
};

/**
 * Formats an ISO timestamp into separate full-month date and 12-hour time strings.
 */
export const formatDateAndTimeParts = (
  rawDate?: string | null
): { date: string; time: string } => {
  const parsed = parseFlexibleDate(rawDate);
  if (!parsed) {
    return { date: 'Not recorded', time: '--:--' };
  }
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const day = String(parsed.getDate()).padStart(2, '0');
  const month = months[parsed.getMonth()];
  const year = parsed.getFullYear();
  const hours24 = parsed.getHours();
  const hours12 = String(hours24 % 12 || 12).padStart(2, '0');
  const minutes = String(parsed.getMinutes()).padStart(2, '0');
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  return {
    date: `${day} ${month} ${year}`,
    time: `${hours12}:${minutes} ${ampm}`,
  };
};

/**
 * Estimates remaining time string from elapsed milliseconds and completion percentage.
 */
export const formatEtaRemaining = (elapsedMs: number, percent: number): string => {
  if (percent >= 100) return 'Finishing up...';
  if (percent < 3 || elapsedMs < 400) return 'Calculating remaining time...';
  const totalEstimatedMs = elapsedMs / (percent / 100);
  const remainingSec = Math.max(1, Math.round((totalEstimatedMs - elapsedMs) / 1000));
  if (remainingSec < 60) {
    return `~${remainingSec}s remaining`;
  }
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  return secs > 0 ? `~${mins}m ${secs}s remaining` : `~${mins}m remaining`;
};
