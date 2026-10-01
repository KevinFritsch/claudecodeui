import React, { useCallback, useEffect, useRef, type Dispatch, type SetStateAction, useState } from 'react';

import { ChatInterface } from '@/modules/chat';
import { FileTree } from '@/modules/file-tree';
import { StandaloneShell } from '@/modules/standalone-shell';
import { GitPanel } from '@/modules/git-panel';
import { PluginTabContent } from '@/modules/plugins';
import { BrowserUsePanel, useBrowserUseEnabled } from '@/modules/browser-use';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { TaskMasterPanel, useTaskMasterProjectSync, useTasksSettings } from '@/modules/task-master';
import type { AppTab, DirectoryRevealRequest, Project, ProjectSession, ResolvedSplitPane, SessionEstablishedContext, SessionNavigationOptions, SettingsMainTab, SplitPaneTab } from '@/shared/types';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { useFileOpenResolver } from '@/modules/project-workspace/hooks/useFileOpenResolver';
import { EditorSidebar, useEditorSidebar } from '@/modules/code-editor';
import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';
import WorkspaceErrorBoundary from '@/modules/project-workspace/WorkspaceErrorBoundary';
import WorkspaceSplitView from '@/modules/project-workspace/WorkspaceSplitView';
import { useSplitLayout } from '@/modules/project-workspace/hooks/useSplitLayout';

const SPLIT_PANE_TABS = new Set<AppTab>(['chat', 'shell', 'files', 'git']);
const isSplitPaneTab = (tab: AppTab): tab is SplitPaneTab => SPLIT_PANE_TABS.has(tab);

type WorkspaceMainProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  /** Switches the app to another project — used by the git panel's Worktrees view. */
  onProjectSelect: (project: Project) => void;
  /** Silently re-syncs the sidebar project list after worktree projects change. */
  onProjectsRefresh: () => void;
  /** Persists a new title for a session; resolves false when the backend refuses it. Used by the header's inline rename. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

/** Rendered by ProjectMainRegion to show the selected project's active tab: chat, files, shell, git, tasks, browser or a plugin. */
function WorkspaceMain({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onProjectSelect,
  onProjectsRefresh,
  onRenameSession,
}: WorkspaceMainProps) {
  const preferences = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const browserUseEnabled = useBrowserUseEnabled();

  useTaskMasterProjectSync(selectedProject);
  // The folder an in-chat `path/` reference asked to reveal. Held as an object
  // so that re-clicking the same folder is a new request the tree acts on.
  const [revealDirectory, setRevealDirectory] = useState<DirectoryRevealRequest | null>(null);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
    handleUnsavedChangesChange,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

  // Stable so React.memo(ChatInterface) can bail out: an inline arrow here made
  // every WorkspaceMain render re-render the whole chat tree, including during
  // an editor-divider drag.
  const showAllTasks = useCallback(() => {
    setActiveTab('tasks');
  }, [setActiveTab]);

  const openFile = useCallback((filePath: string) => {
    if (handleFileOpen(filePath)) {
      setActiveTab('files');
    }
  }, [handleFileOpen, setActiveTab]);

  // Opens the editor side panel in place, keeping the current tab (e.g. chat).
  const openFileInEditor = useCallback((filePath: string, line?: number | null) => {
    resolvedFileOpen(filePath, undefined, line);
  }, [resolvedFileOpen]);

  // Directories cannot be read as text: reveal them in the file tree instead.
  const openDirectory = useCallback((directoryPath: string) => {
    setActiveTab('files');
    setRevealDirectory({ path: directoryPath });
  }, [setActiveTab]);

  const splitLayout = useSplitLayout({
    selectedProject,
    selectedSession,
    newSessionTrigger,
    onNavigateToSession,
    isMobile,
  });

  // Chat, Shell, Files and Source Control belong to each split pane; the
  // header's tabs drive the focused pane. Tasks, Browser and plugins stay
  // workspace-wide and replace the split view while open.
  const isPaneTabActive = isSplitPaneTab(activeTab);
  const { setPaneTab } = splitLayout;
  const focusedPane = splitLayout.panes.find((pane) => pane.isFocused) ?? null;
  const focusedPaneId = focusedPane?.paneId ?? null;
  const focusedPaneTab = focusedPane?.tab ?? 'chat';
  const focusedPaneIdRef = useRef(focusedPaneId);
  focusedPaneIdRef.current = focusedPaneId;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // Header tab clicks and programmatic switches (open file → Files) land on the focused pane.
  useEffect(() => {
    if (isSplitPaneTab(activeTab) && focusedPaneIdRef.current) {
      setPaneTab(focusedPaneIdRef.current, activeTab);
    }
  }, [activeTab, setPaneTab]);

  // A pane's own tab bar, or moving focus to a pane on another tab, updates
  // the header. Skipped on mount so a restored header tab wins over the pane's.
  const hasSyncedPaneTabRef = useRef(false);
  useEffect(() => {
    if (!hasSyncedPaneTabRef.current) {
      hasSyncedPaneTabRef.current = true;
      return;
    }
    if (isSplitPaneTab(activeTabRef.current) && activeTabRef.current !== focusedPaneTab) {
      setActiveTab(focusedPaneTab);
    }
  }, [focusedPaneId, focusedPaneTab, setActiveTab]);

  const renderPane = useCallback((pane: ResolvedSplitPane) => {
    const isPaneVisible = isPaneTabActive;
    return (
      <>
        <div className={`h-full ${pane.tab === 'chat' ? 'block' : 'hidden'}`}>
          <WorkspaceErrorBoundary showDetails>
            <ChatInterface
              isActive={isPaneVisible && pane.tab === 'chat'}
              isFocusedPane={pane.isFocused}
              selectedProject={pane.project}
              selectedSession={pane.session}
              ws={ws}
              sendMessage={sendMessage}
              onFileOpen={handleFileOpen}
              onNavigateToSession={onNavigateToSession}
              onSessionEstablished={onSessionEstablished}
              onShowSettings={onShowSettings}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              sendByCtrlEnter={sendByCtrlEnter}
              externalMessageUpdate={externalMessageUpdate}
              newSessionTrigger={pane.newSessionTrigger}
              onShowAllTasks={tasksEnabled ? showAllTasks : null}
            />
          </WorkspaceErrorBoundary>
        </div>

        {pane.project && pane.tab === 'shell' && (
          <div className="h-full w-full overflow-hidden">
            <StandaloneShell
              project={pane.project}
              session={pane.session}
              showHeader={false}
              isActive={isPaneVisible}
            />
          </div>
        )}

        {pane.project && pane.tab === 'files' && (
          <div className="h-full overflow-hidden">
            <FileTree
              selectedProject={pane.project}
              onFileOpen={handleFileOpen}
              revealDirectory={pane.isFocused ? revealDirectory : null}
            />
          </div>
        )}

        {pane.project && pane.tab === 'git' && (
          <div className="h-full overflow-hidden">
            <GitPanel
              selectedProject={pane.project}
              isMobile={isMobile}
              onFileOpen={handleFileOpen}
              onProjectSelect={onProjectSelect}
              onProjectsRefresh={onProjectsRefresh}
            />
          </div>
        )}
      </>
    );
  }, [
    externalMessageUpdate,
    handleFileOpen,
    isMobile,
    isPaneTabActive,
    onNavigateToSession,
    onProjectSelect,
    onProjectsRefresh,
    onSessionEstablished,
    onShowSettings,
    revealDirectory,
    sendByCtrlEnter,
    sendMessage,
    showAllTasks,
    showRawParameters,
    showThinking,
    tasksEnabled,
    ws,
  ]);

  const handlePaneTabChange = useCallback((paneId: string, tab: SplitPaneTab) => {
    setPaneTab(paneId, tab);
  }, [setPaneTab]);

  // Stable arguments keep usePaletteOpsRegister's effect from tearing down and
  // rewriting the whole palette registry on every render.
  usePaletteOpsRegister({ openFile, openFileInEditor, openDirectory });

  if (isLoading) {
    return <WorkspaceStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <WorkspaceStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  return (
    <div className="flex h-full flex-col">
      <WorkspaceHeader
        activeTab={isPaneTabActive ? focusedPaneTab : activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        shouldShowBrowserTab={shouldShowBrowserTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onRenameSession={onRenameSession}
        splitLayout={splitLayout.layout}
        onSplitLayoutChange={splitLayout.setLayout}
        showSplitLayoutControls={isPaneTabActive}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <WorkspaceSplitView
            panes={splitLayout.panes}
            isVisible={isPaneTabActive}
            onFocusPane={splitLayout.focusPane}
            onClosePane={splitLayout.closePane}
            onDropSession={splitLayout.dropSession}
            onPaneTabChange={handlePaneTabChange}
            renderPane={renderPane}
          />

          {shouldShowTasksTab && <TaskMasterPanel isVisible={activeTab === 'tasks'} />}

          {shouldShowBrowserTab && activeTab === 'browser' && (
            <div className="h-full overflow-hidden">
              <BrowserUsePanel isVisible={activeTab === 'browser'} onShowSettings={onShowSettings} />
            </div>
          )}

          {activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <PluginTabContent
                pluginName={activeTab.replace('plugin:', '')}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
              />
            </div>
          )}
        </div>

        <EditorSidebar
          editingFile={editingFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          onUnsavedChangesChange={handleUnsavedChangesChange}
          projectPath={selectedProject.path}
          // Only a lone Files pane hands the width to the editor; in a split the other panes keep theirs.
          fillSpace={isPaneTabActive && focusedPaneTab === 'files' && splitLayout.panes.length === 1}
        />
      </div>
    </div>
  );
}

export default React.memo(WorkspaceMain);
