import { Browser } from "./browser/Browser";
import { ForeignBrowser } from "./foreign/ForeignBrowser";
import { Help } from "./help/Help";
import { Updates } from "./update/Updates";
import { CrashReports } from "./settings/CrashReports";
import { Language } from "./settings/Language";
import { Speed } from "./settings/Speed";
import { useLocale } from "./i18n";

export function App() {
  // Re-render the whole tree when the language changes (no reload, no lost state).
  useLocale();
  return (
    <main>
      <Browser
        help={<Help />}
        foreign={<ForeignBrowser />}
        tools={{
          settings: (
            <CrashReports>
              <Language />
              <Speed />
              <Updates />
            </CrashReports>
          ),
        }}
      />
    </main>
  );
}
