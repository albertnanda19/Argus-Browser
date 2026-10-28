import { useState } from "react";
import type { Profile } from "../shared/profile";
import type { ArgusRuntime } from "./api-runtime";
import { BrowserSetupSection } from "./BrowserSetupSection";
import { ProfileSection } from "./ProfileSection";
import { SessionSection } from "./SessionSection";
import { texts } from "./texts";

type CockpitProps = {
  readonly runtime: ArgusRuntime | null;
  readonly isConnected: boolean;
};

export function Cockpit({ runtime, isConnected }: CockpitProps) {
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);

  const handleDeleted = (profileId: string): void => {
    setSelectedProfile((current) =>
      current !== null && current.id === profileId ? null : current,
    );
  };

  return (
    <div className="cockpit">
      <aside className="sidebar" aria-label={texts.sidebar.label}>
        {runtime !== null && isConnected ? (
          <>
            <ProfileSection
              runtime={runtime}
              selectedProfileId={selectedProfile?.id ?? null}
              onSelect={setSelectedProfile}
              onDeleted={handleDeleted}
            />
            <SessionSection
              key={selectedProfile?.id ?? "none"}
              runtime={runtime}
              profile={selectedProfile}
            />
            <BrowserSetupSection runtime={runtime} />
          </>
        ) : (
          <p className="panel-note">{texts.sidebar.unavailable}</p>
        )}
      </aside>

      <main className="workspace">
        <section className="empty-state" aria-labelledby="workspace-heading">
          <h2 className="empty-state-heading" id="workspace-heading">
            {texts.workspace.heading}
          </h2>
          <p className="empty-state-body">{texts.workspace.body}</p>
        </section>
      </main>
    </div>
  );
}
