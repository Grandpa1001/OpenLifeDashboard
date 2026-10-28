import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { Field } from "../../../lib/forms/field.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { createScreen } from "../api/screens.js";

class CreateFailure extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure) {
    super("screen not created");
    this.name = "CreateFailure";
    this.failure = failure;
  }
}

/** The first screen of the owner (Scope §5.4): the Designer has nothing to arrange until one exists. */
export function CreateScreenForm() {
  const { t } = useTranslation("designer");
  const queryClient = useQueryClient();
  const [name, setName] = useState(() => t("create.defaultName"));
  const create = useMutation({
    mutationFn: async (screenName: string) => {
      const result = await createScreen(screenName);
      if (!result.ok) throw new CreateFailure(result.failure);
      return result.value;
    },
    onSuccess: (screen) => queryClient.setQueryData(queryKeys.screens.list, screen),
  });
  const failure = create.error instanceof CreateFailure ? create.error.failure : null;

  function submit(event: FormEvent): void {
    event.preventDefault();
    create.mutate(name);
  }

  return (
    <form className="card designer-create" onSubmit={submit} noValidate>
      <h2>{t("create.heading")}</h2>
      <p>{t("create.text")}</p>
      <Field label={t("create.name")} value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
      {failure === null || failure.kind === "aborted" ? null : <FailureAlert message={describeFailure(failure)} />}
      <button type="submit" disabled={create.isPending}>
        {t("create.submit")}
      </button>
    </form>
  );
}
