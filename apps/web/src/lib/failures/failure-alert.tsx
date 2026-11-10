import { useTranslation } from "react-i18next";
import type { ErrorMessage } from "./error-message.js";

/** The lines of a failure: the translated text of its code and, if the server gave one, the reference code to find it in the log. */
export function FailureLines({ message }: Readonly<{ message: ErrorMessage }>) {
  const { t } = useTranslation("errors");
  return (
    <>
      <p>{message.minutes === undefined ? t(message.key) : t(message.key, { count: message.minutes })}</p>
      {message.requestId === null ? null : <p className="alert-reference">{t("requestReference", { requestId: message.requestId })}</p>}
    </>
  );
}

/** A failure as an alert. */
export function FailureAlert({ message }: Readonly<{ message: ErrorMessage }>) {
  return (
    <div className="alert" role="alert">
      <FailureLines message={message} />
    </div>
  );
}
