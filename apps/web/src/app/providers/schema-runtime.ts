// Imported first by main.tsx: the schemas of the transport are built when their modules load, so the choice of
// the parser has to be made before any of them (the policy of the page forbids generated code, D60.1).
import { useInterpretedSchemas } from "@openlife/contracts/schema-runtime";

useInterpretedSchemas();
