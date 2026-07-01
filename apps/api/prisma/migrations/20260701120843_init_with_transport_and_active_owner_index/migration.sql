-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "nickname" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "status" TEXT NOT NULL DEFAULT 'active',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "passwordKind" TEXT NOT NULL DEFAULT 'user_set',
    "passwordExpiresAt" DATETIME,
    "passwordUpdatedAt" DATETIME,
    "passwordResetAt" DATETIME,
    "passwordResetById" TEXT,
    "approvedAt" DATETIME,
    "approvedById" TEXT,
    "lastLoginAt" DATETIME,
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkspaceDirectory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "source" TEXT NOT NULL DEFAULT 'managed',
    "metadata" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkspaceDirectory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "gitUrl" TEXT,
    "description" TEXT,
    "runtimeType" TEXT,
    "isolationScope" TEXT,
    "sandboxEngine" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Workspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'regular',
    "runStatus" TEXT NOT NULL DEFAULT 'idle',
    "pendingUserAction" TEXT,
    "workspaceId" TEXT NOT NULL,
    "agentType" TEXT NOT NULL DEFAULT 'claude',
    "agentSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "runId" TEXT,
    "parentId" TEXT,
    "format" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("id", "conversationId"),
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentType" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "models" JSONB NOT NULL,
    "extraConfig" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ModelProvider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "updatedBy" TEXT
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "runtimeType" TEXT NOT NULL DEFAULT 'local',
    "runtimeInstanceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "phase" TEXT,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "usage" JSONB,
    CONSTRAINT "Run_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "runSeq" INTEGER NOT NULL,
    "eventKey" TEXT,
    "type" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "chainId" TEXT,
    "refs" JSONB,
    "summary" TEXT,
    "data" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RuntimeInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runtimeType" TEXT NOT NULL,
    "isolationScope" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "runtimeInstanceId" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'http',
    "status" TEXT NOT NULL DEFAULT 'running',
    "expiresAt" DATETIME,
    "metadata" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkspaceRuntimeInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkspaceRuntimeInstance_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkspaceRuntimeInstance_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "RuntimeInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceDirectory_workspaceId_key" ON "WorkspaceDirectory"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceDirectory_rootPath_key" ON "WorkspaceDirectory"("rootPath");

-- CreateIndex
CREATE INDEX "Workspace_userId_idx" ON "Workspace"("userId");

-- CreateIndex
CREATE INDEX "Workspace_userId_deletedAt_createdAt_idx" ON "Workspace"("userId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_status_deletedAt_updatedAt_idx" ON "Conversation"("workspaceId", "status", "deletedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_status_deletedAt_createdAt_idx" ON "Conversation"("workspaceId", "status", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_runId_createdAt_idx" ON "Message"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "ModelProvider_agentType_scope_idx" ON "ModelProvider"("agentType", "scope");

-- CreateIndex
CREATE INDEX "ModelProvider_agentType_userId_idx" ON "ModelProvider"("agentType", "userId");

-- CreateIndex
CREATE INDEX "ModelProvider_agentType_scope_userId_name_idx" ON "ModelProvider"("agentType", "scope", "userId", "name");

-- CreateIndex
CREATE INDEX "ModelProvider_userId_idx" ON "ModelProvider"("userId");

-- CreateIndex
CREATE INDEX "Run_conversationId_status_createdAt_idx" ON "Run"("conversationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Run_status_createdAt_idx" ON "Run"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RunEvent_runId_runSeq_idx" ON "RunEvent"("runId", "runSeq");

-- CreateIndex
CREATE INDEX "RunEvent_runId_type_runSeq_idx" ON "RunEvent"("runId", "type", "runSeq");

-- CreateIndex
CREATE INDEX "RunEvent_runId_origin_runSeq_idx" ON "RunEvent"("runId", "origin", "runSeq");

-- CreateIndex
CREATE INDEX "RunEvent_runId_targetType_targetId_runSeq_idx" ON "RunEvent"("runId", "targetType", "targetId", "runSeq");

-- CreateIndex
CREATE INDEX "RunEvent_runId_chainId_runSeq_idx" ON "RunEvent"("runId", "chainId", "runSeq");

-- CreateIndex
CREATE INDEX "RunEvent_type_createdAt_idx" ON "RunEvent"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunEvent_runId_runSeq_key" ON "RunEvent"("runId", "runSeq");

-- CreateIndex
CREATE UNIQUE INDEX "RunEvent_runId_eventKey_key" ON "RunEvent"("runId", "eventKey");

-- CreateIndex
CREATE INDEX "RuntimeInstance_runtimeType_isolationScope_status_idx" ON "RuntimeInstance"("runtimeType", "isolationScope", "status");

-- CreateIndex
CREATE INDEX "RuntimeInstance_ownerId_idx" ON "RuntimeInstance"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeInstance_runtimeType_runtimeInstanceId_key" ON "RuntimeInstance"("runtimeType", "runtimeInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceRuntimeInstance_workspaceId_key" ON "WorkspaceRuntimeInstance"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceRuntimeInstance_resourceId_idx" ON "WorkspaceRuntimeInstance"("resourceId");

-- Partial unique index: 同一个 ownerId 同时只能有一条非终态(starting/running)记录,
-- 用于并发 launch 防重。SQLite 原生支持 filtered index,Prisma schema 语法本身
-- 表达不了"只对部分行生效",所以这条索引不在 schema.prisma 里,只存在于 migration 里。
CREATE UNIQUE INDEX "runtime_instance_active_owner_idx"
ON "RuntimeInstance" ("ownerId")
WHERE "status" IN ('starting', 'running');
