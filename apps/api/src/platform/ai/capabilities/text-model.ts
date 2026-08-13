/**
 * Platform-facing text model port.
 *
 * Keep the existing capability definition as the source of truth so the new
 * platform boundary cannot drift from the providers compatibility surface.
 */
export type {
  TextModel,
  TextModelMessage,
  TextModelRequest,
  TextModelResponse,
} from "../../../capabilities/text-model";
