import { Directory, File, Paths } from 'expo-file-system';

export interface ProjectMeta {
  beneficiaryCode: string;
  originalCode: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

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
  return formatAgentName(userName);
};

export const getSafeCodeDirName = (code: string): string =>
  code.replace(/[\\/:*?"<>|]/g, '_') || 'NO_CODE';

export const getProjectDirectory = (code: string): Directory =>
  new Directory(Paths.document, 'HousingInspection', getSafeCodeDirName(code));

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
      authorName: parsed.authorName || '',
      createdAt: parsed.createdAt || '',
      updatedAt: parsed.updatedAt || '',
    };
  } catch {
    return null;
  }
};

/**
 * Writes or updates `.project_meta.json` inside `Paths.document/HousingInspection/<safeCodeDir>/`.
 */
export const writeProjectMeta = async (
  projectDir: Directory,
  params: {
    beneficiaryCode: string;
    originalCode?: string | null;
    authorName: string;
    createdAt?: string | null;
    updatedAt?: string | null;
  }
): Promise<ProjectMeta> => {
  projectDir.create({ intermediates: true, idempotent: true });
  const existing = await readProjectMeta(projectDir);
  const nowIso = new Date().toISOString();

  const meta: ProjectMeta = {
    beneficiaryCode: params.beneficiaryCode,
    originalCode: params.originalCode || existing?.originalCode || params.beneficiaryCode,
    authorName: params.authorName || existing?.authorName || 'Field Agent',
    createdAt: params.createdAt || existing?.createdAt || nowIso,
    updatedAt: params.updatedAt || nowIso,
  };

  const metaFile = new File(projectDir, '.project_meta.json');
  metaFile.write(JSON.stringify(meta, null, 2));
  return meta;
};

/**
 * Formats an ISO or SQLite timestamp cleanly as `DD MMM YYYY, hh:mm A`.
 */
export const formatDisplayDateTime = (rawDate?: string | null): string => {
  if (!rawDate) return 'Not recorded yet';
  const normalized = rawDate.includes('T') || rawDate.includes('Z')
    ? rawDate
    : rawDate.replace(' ', 'T') + 'Z';
  let date = new Date(normalized);
  if (isNaN(date.getTime())) {
    date = new Date(rawDate);
  }
  if (isNaN(date.getTime())) return rawDate;

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
