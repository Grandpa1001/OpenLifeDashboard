// Calls of a change of the structure (Architektura §4.6, §5.2; D26.2, D28.2–D30.1): the preview that
// writes nothing and answers with the effects and a plan, and the change carried out on that plan.
import { structurePath, structurePreviewPath, structureChangedSchema, structurePreviewSchema, type StructureChangeRequest } from "@openlife/contracts/http/registries";
import { apiRequest } from "../../../lib/api-client/request.js";

export const previewStructureChange = (symbol: string, change: StructureChangeRequest, signal?: AbortSignal) =>
  apiRequest({ method: "POST", path: structurePreviewPath(symbol), body: { change }, schema: structurePreviewSchema, signal });

export const carryOutStructureChange = (symbol: string, change: StructureChangeRequest, planToken: string, signal?: AbortSignal) =>
  apiRequest({ method: "POST", path: structurePath(symbol), body: { change, planToken }, schema: structureChangedSchema, signal });
