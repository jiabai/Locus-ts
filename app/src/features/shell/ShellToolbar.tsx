import { ChevronLeft, ChevronRight, Minus, PanelLeft, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWindowChromeController } from "../window/useWindowChromeController";

type ShellToolbarProps = {
  collapsed: boolean;
  title: string;
  canBack: boolean;
  canForward: boolean;
  disabledReason: string;
  onToggleSidebar: () => void;
  onBack: () => void;
  onForward: () => void;
};

export function ShellToolbar({ collapsed, title, canBack, canForward, disabledReason, onToggleSidebar, onBack, onForward }: ShellToolbarProps) {
  const { t } = useTranslation("shell");
  const { t: commonT } = useTranslation("common");
  const chrome = useWindowChromeController();
  return (
    <header className="app-toolbar shell-toolbar" data-tauri-drag-region="" onMouseDown={chrome.handleToolbarMouseDown}>
      <div className="shell-toolbar-navigation">
        <button type="button" className="shell-toolbar-button" onClick={onToggleSidebar} aria-label={t(collapsed ? "toolbar.expandSidebar" : "toolbar.collapseSidebar")} title={t(collapsed ? "toolbar.expandSidebar" : "toolbar.collapseSidebar")} aria-expanded={!collapsed} aria-controls="app-sidebar">
          <PanelLeft size={18} aria-hidden="true" />
        </button>
        <button type="button" className="shell-toolbar-button" onClick={onBack} disabled={!canBack} aria-label={t("toolbar.back")} title={canBack ? t("toolbar.back") : disabledReason}>
          <ChevronLeft size={17} aria-hidden="true" />
        </button>
        <button type="button" className="shell-toolbar-button" onClick={onForward} disabled={!canForward} aria-label={t("toolbar.forward")} title={canForward ? t("toolbar.forward") : disabledReason}>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>
      {title && <span className="shell-toolbar-title" data-tauri-drag-region="">{title}</span>}
      <div className="shell-toolbar-utilities" />
      <div className="shell-window-controls" role="group" aria-label={commonT("window.controls")}>
        <button type="button" onClick={chrome.minimizeWindow} aria-label={commonT("window.minimize")}><Minus size={15} aria-hidden="true" /></button>
        <button type="button" onClick={chrome.toggleMaximizeWindow} aria-label={commonT("window.maximize")}><Square size={12} aria-hidden="true" /></button>
        <button type="button" className="shell-window-close" onClick={chrome.closeWindow} aria-label={commonT("window.close")}><X size={17} aria-hidden="true" /></button>
      </div>
    </header>
  );
}
