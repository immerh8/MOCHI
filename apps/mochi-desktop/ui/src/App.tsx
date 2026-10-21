import { Browser } from "./browser/Browser";
import { ForeignBrowser } from "./foreign/ForeignBrowser";
import { Help } from "./help/Help";
import { Updates } from "./update/Updates";
import { CrashReports } from "./settings/CrashReports";

export function App() {
  return (
    <main>
      <Browser
        help={<Help />}
        foreign={<ForeignBrowser />}
        tools={{
          settings: (
            <CrashReports>
              <Updates />
            </CrashReports>
          ),
        }}
      />
    </main>
  );
}
