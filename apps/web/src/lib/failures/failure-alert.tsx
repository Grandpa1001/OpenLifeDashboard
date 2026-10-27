import { useTranslation } from "react-i18next";
import type { ErrorMessage } from "./error-message.js";

/** The translated text of a failure and, if the server gave one, the reference code to find it in the log. */
export function FailureAlert({ message }: Readonly<{ message: ErrorMessage }>) {
  const { t } = useTranslation("errors");
  return (
    <div className="alert" role="alert">
      <p>{message.minutes === undefined ? t(message.key) : t(message.key, { count: message.minutes })}</p>
      {message.requestId === null ? null : <p className="alert-reference">{t("requestReference", { requestId: message.requestId })}</p>}
    </div>
  );
}
