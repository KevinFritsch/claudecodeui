import { memo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { usePaletteOps } from '@/modules/command-palette';
import { QuickSettingsPanel } from '@/modules/quick-settings-panel';
import {
  useProjectActiveSessionState,
  useProjectCommandState,
  useProjectSidebarState,
} from '@/modules/project-workspace/context/ProjectsStateContext';
import type { SlashCommand } from '@/shared/types';

/** Rendered by ProjectWorkspaceShell to bind this module's project state and the chat composer to the quick-settings-panel module (now the Quick access panel). */
function ProjectQuickSettingsRegion() {
  const { selectedProject, setActiveTab } = useProjectCommandState();
  const { sidebarOpen, setSidebarOpen } = useProjectSidebarState();
  const { activeSessionId } = useProjectActiveSessionState();
  const paletteOps = usePaletteOps();
  const navigate = useNavigate();

  // A picked command belongs in the chat composer, which only accepts focus
  // while the Chat tab is showing.
  const handleInsertCommand = useCallback((command: SlashCommand) => {
    setActiveTab('chat');
    paletteOps.insertComposerText(`${command.name} `);
  }, [paletteOps, setActiveTab]);

  // A recent session opens in the Sessions view, whatever was showing.
  const handleOpenSession = useCallback((sessionId: string) => {
    setActiveTab('chat');
    navigate(`/session/${sessionId}`);
  }, [navigate, setActiveTab]);

  const openSidebar = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);
  const closeSidebar = useCallback(() => setSidebarOpen(false), [setSidebarOpen]);

  return (
    <QuickSettingsPanel
      selectedProject={selectedProject}
      onInsertCommand={handleInsertCommand}
      onOpenSession={handleOpenSession}
      activeSessionId={activeSessionId}
      isSidebarOpen={sidebarOpen}
      onOpenSidebar={openSidebar}
      onCloseSidebar={closeSidebar}
    />
  );
}

export default memo(ProjectQuickSettingsRegion);
