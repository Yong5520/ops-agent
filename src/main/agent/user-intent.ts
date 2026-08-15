// Heuristic classification of the user's latest message intent.
//
// Used to gate the task-resume directive in the system prompt: when the user
// is asking a question (not requesting continuation), the agent must answer
// with text and NOT auto-resume executing an incomplete task list. This was
// the root cause of the 2026-08-11 nginx hardening incident: the user asked
// "以上动作不影响 用户的请求吧" and the agent treated it as a cue to proceed,
// immediately calling exec for the backup step (WRITE, rejected in the
// AuthDialog).
//
// Conservative by design: a question marker dominates, so a message like
// "执行以上动作不影响吧" (action verb + question particle) is treated as a
// question, not a continuation command. False negatives (treating a real
// instruction as a question) are safe - the agent answers with text and the
// user re-phrases; false positives (executing on a question) are the danger.

const CONTINUATION_RE = /继续|接着|下一步|接下去|往下做|resume|proceed|continue/i;
const ACTION_VERB_RE = /执行|开始|部署|修复|处理|配置|安装|更新|卸载|启动|停止|重启|加固|清理|清除/;
const QUESTION_RE = /[?？]|吗|吧|么|呢|是否|能不能|会不会|可不可以|有没有|对不对|行不行|是不是|确认.*吧/;

/**
 * True when the user's message reads as a question / seeking confirmation
 * rather than an instruction to act. Conservative: any question marker => true.
 * "以上动作不影响用户的请求吧" => true; "执行以上安全加固" => false.
 */
export function isQuestion(message: string | undefined | null): boolean {
  const m = (message ?? '').trim();
  if (!m) return false;
  return QUESTION_RE.test(m);
}

/**
 * True when the user's message explicitly requests continuing/resuming an
 * action (e.g. "继续", "执行以上方案", "开始"). A question never counts as a
 * continuation, even if it contains an action verb ("执行以上动作不影响吧"
 * => false). Used to gate the task-resume "continue executing" directive so a
 * question doesn't auto-trigger resumption of an incomplete task list.
 */
export function isContinuationRequest(message: string | undefined | null): boolean {
  const m = (message ?? '').trim();
  if (!m) return false;
  // A question marker dominates: "我们开始吧" is treated as non-continuation
  // (the user can say "开始" plainly to trigger continuation). This is the
  // safe direction - it prevents executing on a question.
  if (QUESTION_RE.test(m)) return false;
  return CONTINUATION_RE.test(m) || ACTION_VERB_RE.test(m);
}
