/**
 * @rescript/renderer — THE question renderer.
 *
 * One implementation, two surfaces: the respondent runtime renders a survey
 * with it, and the Studio's Live Question Canvas renders the question being
 * programmed with it. There is deliberately no second "editor renderer" — the
 * whole point is that what the programmer builds against and what the
 * respondent answers are the same component tree, so they cannot drift.
 *
 * Consumers must also load the stylesheet:
 *
 *     import "@rescript/renderer/questions.css";
 *
 * It styles rendered question content only (no page reset, no app chrome), and
 * everything in it is themed through the --rs-* custom properties.
 */
export { QuestionRenderer, ctxOf, optionsClass, gridColumnsStyle, useOptionFilter, OTHER, EXCLUSIVE } from "./QuestionRenderer";
export type { QRProps } from "./QuestionRenderer";
export { MediaEmbed, SafeImage } from "./Media";
export { SpeechInputButton, speechInputAvailable } from "./SpeechInput";
export { readAloudAvailable, spokenText, speechLangFor, speak, stopSpeaking, useReadAloud } from "./ReadAloud";
export { variantRenderers, registerVariantRenderer } from "./variants/registry";
export { anchor, cellAnchor, parseCellId, CELL_SEP } from "./authoring";
export type { AuthoringAnchor, AuthoringElementKind } from "./authoring";
export { VoiceConsole } from "./voice/VoiceConsole";
export type { VoiceConsoleProps } from "./voice/VoiceConsole";
export { speakSegments, useSpeaker } from "./voice/speaker";
export { registerVoiceProvider, ttsProvider, sttProvider, browserTts, browserStt, chooseVoice } from "./voice/providers";
export type { TtsProvider, SttProvider, VoiceInfo, SpeakOptions, SttResult, SttSession } from "./voice/providers";
export { QuestionAudio } from "./QuestionAudio";
