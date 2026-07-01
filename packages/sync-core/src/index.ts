export { applyStringToYText, CONTENT_FIELD } from './ytext.js';
export { applyEdits, findReplaceEdits } from './edits.js';
export type { RangeEdit, FindReplaceOptions } from './edits.js';
export { colorForSeed, makePresence } from './presence.js';
export { lineDiff, mapOffsetThroughDiff } from './diff.js';
export type { LineDiffChunk, LineDiffOp } from './diff.js';
export {
  COMMENTS_FIELD,
  SUGGESTIONS_FIELD,
  encodeAnchor,
  resolveAnchor,
  addComment,
  addReply,
  setResolved,
  snapshotComments,
  addSuggestion,
  addSuggestionReply,
  acceptSuggestion,
  rejectSuggestion,
  updateSuggestion,
  removeSuggestion,
  getSuggestion,
  snapshotSuggestions,
} from './annotations.js';
export type {
  CommentReplyData,
  CommentThreadData,
  SuggestionData,
  SuggestionStatus,
} from './annotations.js';
export type {
  DocMeta,
  CreateDocRequest,
  PresenceUser,
  Manifest,
  VersionMeta,
  TokenScope,
  AuthUser,
  ApiTokenMeta,
  MeResponse,
  DocRole,
  AclEntry,
  WorkspaceRole,
  Workspace,
  WorkspaceMember,
  WorkspaceWithRole,
  AuditAction,
  AuditTargetType,
  AuditEntry,
} from './types.js';
