import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getConfig } from '../api';
import type { AppConfigResponse } from '../types';

const ConfigContext = createContext<{ config: AppConfigResponse | null; failed: boolean }>({
  config: null,
  failed: false,
});

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfigResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch(() => setFailed(true));
  }, []);
  return <ConfigContext.Provider value={{ config, failed }}>{children}</ConfigContext.Provider>;
}

export function useConfig() {
  return useContext(ConfigContext);
}
