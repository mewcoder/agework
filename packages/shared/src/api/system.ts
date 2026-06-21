import type { AgentType } from "../common";

export type AboutResponse = {
  platform: {
    name: string;
    description: string;
    version: string;
  };
  agents: {
    id: AgentType;
    name: string;
    version: string;
  }[];
};
