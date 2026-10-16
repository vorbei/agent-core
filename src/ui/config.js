// What a mounted chat was configured with (its wording and the product's slots), read by the
// components below ChatHost without passing it through each of them.
import { createContext, useContext } from "react";
import { defaultWording } from "./wording.js";

export const ChatConfig = createContext({ wording: defaultWording(), slots: {} });

/** @returns {{ wording: import("./wording.js").ChatWording, slots: Record<string, any> }} */
export function useChatConfig() {
  return useContext(ChatConfig);
}
