import { useState } from "react";
import { Alert, Intent } from "@blueprintjs/core";
import { LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * One confirmation for every "Log out" button, wherever it lives.
 * Usage: `const { askLogout, logoutDialog } = useLogoutConfirm(handleLogout);`
 * Render `{logoutDialog}` once and call `askLogout()` from the button.
 */
export function useLogoutConfirm(onConfirm: () => void) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const logoutDialog = (
    <Alert
      isOpen={open}
      icon={<LogOut size={20} />}
      intent={Intent.DANGER}
      confirmButtonText={t("common.logout")}
      cancelButtonText={t("common.cancel")}
      onConfirm={() => {
        setOpen(false);
        onConfirm();
      }}
      onCancel={() => setOpen(false)}
      canEscapeKeyCancel
      canOutsideClickCancel
    >
      <p className="m-0">{t("common.confirmLogout")}</p>
    </Alert>
  );

  return { askLogout: () => setOpen(true), logoutDialog };
}
