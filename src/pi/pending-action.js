// Answer hygiene: a turn that ends with "Typing the value now." and no tool call reports work it
// never did (live bench 2026-09-30, sites-nested-iframes). When the final reply's last sentence
// announces an action, steer the model once to do it or say it was not done. Nothing is executed
// on its behalf. The steer's wording is the product's (`{{CLAIM}}` is the quoted sentence).
// From X Gardener src/pi/extensions/pending-action.js.

const ANNOUNCED = [
  // "Typing the value now." / "Clicking Save now."
  /\b(?:typing|clicking|filling|opening|navigating|submitting|entering|searching|scrolling|retrying|selecting|pressing)\b.{0,40}\bnow\b/i,
  // "Let me click …" / "I'll now open …" / "I'm going to submit …"
  /\b(?:let me|i'?ll|i will|i'?m going to|going to)\s+(?:now\s+|next\s+)?(?:type|click|fill|open|navigate|press|select|submit|search|enter|scroll|try|retry|go)\b/i,
  // "现在去点击…" / "接下来输入…" / "马上提交…"
  /(?:现在|接下来|下一步|马上|随后|这就)(?:我)?[就会将要去来再]*(?:输入|点击|填写|打开|跳转|提交|搜索|尝试|执行|选择|滚动|操作)/
];
// An offer or a condition hands the choice to the user; it is not a pending step.
const OFFER = /\b(?:if you(?:'d)? (?:like|want)|would you like|i can|want me to)\b|如果|如需|需要的话|是否|可以帮你|我可以/i;

export function announcesPendingAction(text) {
  const sentences = String(text || "").trim().split(/(?<=[.!?。！？])\s*|\n+/).map((part) => part.trim()).filter(Boolean);
  const last = sentences.at(-1) || "";
  return !OFFER.test(last) && ANNOUNCED.some((pattern) => pattern.test(last)) ? last.slice(0, 200) : null;
}

export function pendingActionSteer(owner, { onEvent, wording }) {
  return (pi) => pi.on("turn_end", (event) => {
    const message = event.message;
    if (owner.handoff || owner.stepsRemaining <= 0 || message?.role !== "assistant" || message.errorMessage
      || message.content?.some((block) => block.type === "toolCall")) return;
    const claim = announcesPendingAction(messageText(message));
    if (!claim || !owner.reserve("pendingActionSteer").ok) return;
    onEvent?.({ type: "pending_action_steer" });
    pi.sendUserMessage(wording.replace("{{CLAIM}}", JSON.stringify(claim)), { deliverAs: "steer" });
  });
}

function messageText(message) {
  return typeof message?.content === "string" ? message.content
    : (message?.content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
