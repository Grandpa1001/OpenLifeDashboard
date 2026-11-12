import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { fetchFactor } from "../api/security.js";
import { AuditSection } from "../components/audit-section.js";
import { DevicesSection } from "../components/devices-section.js";
import { FactorSection } from "../components/factor-section.js";
import { PasswordSection } from "../components/password-section.js";
import { RecoverySection } from "../components/recovery-section.js";
import { SessionsSection } from "../components/sessions-section.js";
import { useStepUp } from "../components/step-up.js";

/**
 * `/settings/security` (Scope §5.9; D43.7, D43.8): the password, the recovery codes and the second factor, then the
 * sessions, the trusted devices and the audit log. An action that needs a fresh second factor asks for it in a
 * dialog over the page (a TOTP while the factor is in force, the password once it is off) and is done when the
 * proof is given.
 */
export function SecurityPage() {
  const { t } = useTranslation("settings");
  const factor = useQuery({
    queryKey: queryKeys.security.factor,
    queryFn: async ({ signal }) => {
      const result = await fetchFactor(signal);
      if (!result.ok) throw new Error("factor unavailable");
      return result.value;
    },
  });
  const stepUp = useStepUp(factor.data?.policy === "disabled" ? "password" : "code");
  return (
    <>
      <h2 className="visually-hidden">{t("security.heading")}</h2>
      <PasswordSection run={stepUp.run} />
      <RecoverySection run={stepUp.run} factor={factor.data} />
      <FactorSection run={stepUp.run} factor={factor.data} />
      <SessionsSection run={stepUp.run} />
      <DevicesSection run={stepUp.run} />
      <AuditSection />
      {stepUp.dialog}
    </>
  );
}
