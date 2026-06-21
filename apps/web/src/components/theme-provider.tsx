/* eslint-disable react-refresh/only-export-components */
import * as React from "react";

export type Theme = "dark" | "light" | "system";
export type ThemeSkin = "default" | "warm" | "harbor" | "cobalt";
type ResolvedTheme = "dark" | "light";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  defaultSkin?: ThemeSkin;
  storageKey?: string;
  skinStorageKey?: string;
  disableTransitionOnChange?: boolean;
};

export type ThemeProviderState = {
  theme: Theme;
  skin: ThemeSkin;
  setTheme: (theme: Theme) => void;
  setSkin: (skin: ThemeSkin) => void;
};

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";
const THEME_VALUES: Theme[] = ["dark", "light", "system"];
const THEME_SKIN_VALUES: ThemeSkin[] = ["default", "warm", "harbor", "cobalt"];

export const ThemeProviderContext = React.createContext<
  ThemeProviderState | undefined
>(undefined);

function isTheme(value: string | null): value is Theme {
  if (value === null) {
    return false;
  }

  return THEME_VALUES.includes(value as Theme);
}

function isThemeSkin(value: string | null): value is ThemeSkin {
  if (value === null) {
    return false;
  }

  return THEME_SKIN_VALUES.includes(value as ThemeSkin);
}

function getSystemTheme(): ResolvedTheme {
  if (window.matchMedia(COLOR_SCHEME_QUERY).matches) {
    return "dark";
  }

  return "light";
}

function disableTransitionsTemporarily() {
  const style = document.createElement("style");
  style.appendChild(
    document.createTextNode(
      "*,*::before,*::after{-webkit-transition:none!important;transition:none!important}"
    )
  );
  document.head.appendChild(style);

  return () => {
    window.getComputedStyle(document.body);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        style.remove();
      });
    });
  };
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const editableParent = target.closest(
    "input, textarea, select, [contenteditable='true']"
  );
  if (editableParent) {
    return true;
  }

  return false;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  defaultSkin = "default",
  storageKey = "theme",
  skinStorageKey = "skin",
  disableTransitionOnChange = true,
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    const storedTheme = localStorage.getItem(storageKey);
    if (isTheme(storedTheme)) {
      return storedTheme;
    }

    return defaultTheme;
  });
  const [skin, setSkinState] = React.useState<ThemeSkin>(() => {
    const storedSkin = localStorage.getItem(skinStorageKey);
    if (isThemeSkin(storedSkin)) {
      return storedSkin;
    }

    return defaultSkin;
  });
  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      localStorage.setItem(storageKey, nextTheme);
      setThemeState(nextTheme);
    },
    [storageKey]
  );

  const setSkin = React.useCallback(
    (nextSkin: ThemeSkin) => {
      localStorage.setItem(skinStorageKey, nextSkin);
      setSkinState(nextSkin);
    },
    [skinStorageKey]
  );

  const applyVisualState = React.useCallback(
    (nextTheme: Theme, nextSkin: ThemeSkin) => {
      const root = document.documentElement;
      const resolvedTheme =
        nextTheme === "system" ? getSystemTheme() : nextTheme;
      const restoreTransitions = disableTransitionOnChange
        ? disableTransitionsTemporarily()
        : null;

      root.classList.remove("light", "dark");
      root.classList.add(resolvedTheme);
      root.dataset.skin = nextSkin;

      if (restoreTransitions) {
        restoreTransitions();
      }
    },
    [disableTransitionOnChange]
  );

  React.useEffect(() => {
    applyVisualState(theme, skin);

    if (theme !== "system") {
      return undefined;
    }

    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY);
    const handleChange = () => {
      applyVisualState("system", skin);
    };

    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [theme, skin, applyVisualState]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (event.key.toLowerCase() !== "d") {
        return;
      }

      setThemeState((currentTheme) => {
        const nextTheme =
          currentTheme === "dark"
            ? "light"
            : currentTheme === "light"
              ? "dark"
              : getSystemTheme() === "dark"
                ? "light"
                : "dark";

        localStorage.setItem(storageKey, nextTheme);
        return nextTheme;
      });
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [storageKey]);

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) {
        return;
      }

      if (event.key !== storageKey) {
        return;
      }

      if (isTheme(event.newValue)) {
        setThemeState(event.newValue);
        return;
      }

      setThemeState(defaultTheme);
    };

    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [defaultTheme, storageKey]);

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) {
        return;
      }

      if (event.key !== skinStorageKey) {
        return;
      }

      if (isThemeSkin(event.newValue)) {
        setSkinState(event.newValue);
        return;
      }

      setSkinState(defaultSkin);
    };

    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [defaultSkin, skinStorageKey]);

  const value = React.useMemo(
    () => ({
      theme,
      skin,
      setTheme,
      setSkin,
    }),
    [theme, skin, setTheme, setSkin]
  );

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export { useTheme } from "@/hooks/use-theme";
