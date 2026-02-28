#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// src/trello-client.ts
import axios from "axios";
import FormData from "form-data";

// src/rate-limiter.ts
var TokenBucketRateLimiter = class {
  tokens;
  lastRefill;
  maxTokens;
  refillRate;
  // tokens per millisecond
  refillInterval;
  // milliseconds
  constructor(maxRequests, windowMs) {
    this.maxTokens = maxRequests;
    this.tokens = maxRequests;
    this.lastRefill = Date.now();
    this.refillInterval = windowMs;
    this.refillRate = maxRequests / windowMs;
  }
  refillTokens() {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const newTokens = timePassed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
  canMakeRequest() {
    this.refillTokens();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
  async waitForAvailableToken() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.canMakeRequest()) {
          resolve();
        } else {
          const tokensNeeded = 1 - this.tokens;
          const msToWait = tokensNeeded / this.refillRate * 1e3;
          setTimeout(check, Math.min(msToWait, 100));
        }
      };
      check();
    });
  }
};
var createTrelloRateLimiters = () => {
  const apiKeyLimiter = new TokenBucketRateLimiter(300, 1e4);
  const tokenLimiter = new TokenBucketRateLimiter(100, 1e4);
  return {
    apiKeyLimiter,
    tokenLimiter,
    /**
     * Checks if a request can be made without hitting rate limits.
     * This is useful for pre-checking before attempting a request,
     * allowing for more graceful handling of rate limits without blocking.
     *
     * @returns {boolean} True if both API key and token limiters have available tokens
     */
    canMakeRequest() {
      return apiKeyLimiter.canMakeRequest() && tokenLimiter.canMakeRequest();
    },
    /**
     * Waits until tokens are available for both API key and token limiters.
     * This method blocks execution until rate limits allow the request to proceed.
     * Used by the axios interceptor to ensure all requests respect Trello's rate limits.
     *
     * @returns {Promise<void>} Resolves when tokens are available
     */
    async waitForAvailableToken() {
      await Promise.all([
        apiKeyLimiter.waitForAvailableToken(),
        tokenLimiter.waitForAvailableToken()
      ]);
    }
  };
};

// src/trello-client.ts
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import { createReadStream } from "fs";
import { fileURLToPath } from "url";
var CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || ".", ".trello-mcp");
var CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
var TrelloClient = class {
  constructor(config) {
    this.config = config;
    this.defaultBoardId = config.defaultBoardId;
    this.activeConfig = { ...config };
    if (config.boardId && !this.activeConfig.boardId) {
      this.activeConfig.boardId = config.boardId;
    }
    if (this.defaultBoardId && !this.activeConfig.boardId) {
      this.activeConfig.boardId = this.defaultBoardId;
    }
    this.axiosInstance = axios.create({
      baseURL: "https://api.trello.com/1",
      params: {
        key: config.apiKey,
        token: config.token
      }
    });
    this.rateLimiter = createTrelloRateLimiters();
    this.axiosInstance.interceptors.request.use(async (config2) => {
      await this.rateLimiter.waitForAvailableToken();
      return config2;
    });
  }
  axiosInstance;
  rateLimiter;
  defaultBoardId;
  activeConfig;
  /**
   * Load saved configuration from disk
   */
  async loadConfig() {
    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      const data = await fs.readFile(CONFIG_FILE, "utf8");
      const savedConfig = JSON.parse(data);
      if (savedConfig.boardId) {
        this.activeConfig.boardId = savedConfig.boardId;
      }
      if (savedConfig.workspaceId) {
        this.activeConfig.workspaceId = savedConfig.workspaceId;
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  /**
   * Save current configuration to disk
   */
  async saveConfig() {
    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      const configToSave = {
        boardId: this.activeConfig.boardId,
        workspaceId: this.activeConfig.workspaceId
      };
      await fs.writeFile(CONFIG_FILE, JSON.stringify(configToSave, null, 2));
    } catch (error) {
      throw new Error("Failed to save configuration");
    }
  }
  /**
   * Get the current active board ID
   */
  get activeBoardId() {
    return this.activeConfig.boardId;
  }
  /**
   * Get the current active workspace ID
   */
  get activeWorkspaceId() {
    return this.activeConfig.workspaceId;
  }
  /**
   * Set the active board
   */
  async setActiveBoard(boardId) {
    const board = await this.getBoardById(boardId);
    this.activeConfig.boardId = boardId;
    await this.saveConfig();
    return board;
  }
  /**
   * Set the active workspace
   */
  async setActiveWorkspace(workspaceId) {
    const workspace = await this.getWorkspaceById(workspaceId);
    this.activeConfig.workspaceId = workspaceId;
    await this.saveConfig();
    return workspace;
  }
  async handleRequest(requestFn) {
    try {
      return await requestFn();
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 1e3));
          return this.handleRequest(requestFn);
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Trello API Error: ${error.response?.status} ${error.message}`,
          error.response?.data
        );
      } else {
        throw new McpError(ErrorCode.InternalError, "An unexpected error occurred");
      }
    }
  }
  /**
   * List all boards the user has access to
   */
  async listBoards() {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get("/members/me/boards");
      return response.data;
    });
  }
  /**
   * Get a specific board by ID
   */
  async getBoardById(boardId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/boards/${boardId}`);
      return response.data;
    });
  }
  /**
   * List all workspaces the user has access to
   */
  async listWorkspaces() {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get("/members/me/organizations");
      return response.data;
    });
  }
  /**
   * Get a specific workspace by ID
   */
  async getWorkspaceById(workspaceId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/organizations/${workspaceId}`);
      return response.data;
    });
  }
  /**
   * List boards in a specific workspace
   */
  async listBoardsInWorkspace(workspaceId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/organizations/${workspaceId}/boards`);
      return response.data;
    });
  }
  /**
   * Create a new board
   */
  async createBoard(params) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post("/boards", {
        name: params.name,
        desc: params.desc,
        idOrganization: params.idOrganization ?? this.activeConfig.workspaceId,
        defaultLabels: params.defaultLabels,
        defaultLists: params.defaultLists
      });
      return response.data;
    });
  }
  async getCardsByList(boardId, listId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/lists/${listId}/cards`);
      return response.data;
    });
  }
  async getLists(boardId) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "boardId is required when no default board is configured"
      );
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/boards/${effectiveBoardId}/lists`);
      return response.data;
    });
  }
  async getRecentActivity(boardId, limit = 10) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "boardId is required when no default board is configured"
      );
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/boards/${effectiveBoardId}/actions`, {
        params: { limit }
      });
      return response.data;
    });
  }
  async addCard(boardId, params) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post("/cards", {
        idList: params.listId,
        name: params.name,
        desc: params.description,
        due: params.dueDate,
        start: params.start,
        idLabels: params.labels
      });
      return response.data;
    });
  }
  async updateCard(boardId, params) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/cards/${params.cardId}`, {
        name: params.name,
        desc: params.description,
        due: params.dueDate,
        start: params.start,
        dueComplete: params.dueComplete,
        idLabels: params.labels
      });
      return response.data;
    });
  }
  async archiveCard(boardId, cardId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/cards/${cardId}`, {
        closed: true
      });
      return response.data;
    });
  }
  async moveCard(boardId, cardId, listId) {
    const effectiveBoardId = boardId || this.defaultBoardId;
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/cards/${cardId}`, {
        idList: listId,
        ...effectiveBoardId && { idBoard: effectiveBoardId }
      });
      return response.data;
    });
  }
  async addList(boardId, name) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "boardId is required when no default board is configured"
      );
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post("/lists", {
        name,
        idBoard: effectiveBoardId
      });
      return response.data;
    });
  }
  async archiveList(boardId, listId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(`/lists/${listId}/closed`, {
        value: true
      });
      return response.data;
    });
  }
  async getMyCards() {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get("/members/me/cards");
      return response.data;
    });
  }
  async attachImageToCard(boardId, cardId, imageUrl, name) {
    return this.attachFileToCard(boardId, cardId, imageUrl, name || "Image Attachment", void 0);
  }
  async attachImageDataToCard(boardId, cardId, imageData, name, mimeType) {
    return this.handleRequest(async () => {
      let buffer;
      let effectiveMimeType = mimeType || "image/png";
      if (imageData.startsWith("data:")) {
        const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          effectiveMimeType = matches[1];
          buffer = Buffer.from(matches[2], "base64");
        } else {
          throw new McpError(ErrorCode.InvalidRequest, "Invalid data URL format");
        }
      } else {
        buffer = Buffer.from(imageData, "base64");
      }
      const form = new FormData();
      const fileName = name || `screenshot-${Date.now()}.png`;
      form.append("file", buffer, {
        filename: fileName,
        contentType: effectiveMimeType
      });
      form.append("name", fileName);
      form.append("mimeType", effectiveMimeType);
      const response = await this.axiosInstance.post(`/cards/${cardId}/attachments`, form, {
        headers: {
          ...form.getHeaders()
        }
      });
      return response.data;
    });
  }
  async attachFileToCard(boardId, cardId, fileUrl, name, mimeType) {
    return this.handleRequest(async () => {
      if (fileUrl.startsWith("file://")) {
        const localPath = fileURLToPath(fileUrl);
        let effectiveMimeType = mimeType;
        if (!effectiveMimeType) {
          const ext = path.extname(localPath).toLowerCase();
          effectiveMimeType = MIME_TYPES[ext] || "application/octet-stream";
        }
        try {
          await fs.access(localPath);
        } catch (error) {
          throw new McpError(ErrorCode.InvalidRequest, `File not found: ${localPath}`);
        }
        const form = new FormData();
        const fileStream = createReadStream(localPath);
        const fileName = name || path.basename(localPath);
        form.append("file", fileStream, {
          filename: fileName,
          contentType: effectiveMimeType
        });
        form.append("name", fileName);
        form.append("mimeType", effectiveMimeType);
        const response = await this.axiosInstance.post(`/cards/${cardId}/attachments`, form, {
          headers: {
            ...form.getHeaders()
          }
        });
        return response.data;
      } else {
        const remoteUrlPath = new URL(fileUrl).pathname;
        let effectiveMimeType = mimeType;
        if (!effectiveMimeType) {
          const ext = path.extname(remoteUrlPath).toLowerCase();
          effectiveMimeType = MIME_TYPES[ext] || "application/octet-stream";
        }
        const response = await this.axiosInstance.post(`/cards/${cardId}/attachments`, {
          url: fileUrl,
          name: name || "File Attachment",
          mimeType: effectiveMimeType
        });
        return response.data;
      }
    });
  }
  async getCard(cardId, includeMarkdown = false) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/cards/${cardId}`, {
        params: {
          attachments: true,
          checklists: "all",
          checkItemStates: true,
          members: true,
          membersVoted: true,
          labels: true,
          actions: "commentCard",
          actions_limit: 100,
          fields: "all",
          customFieldItems: true,
          list: true,
          board: true,
          stickers: true,
          pluginData: true
        }
      });
      const cardData = response.data;
      if (includeMarkdown) {
        return this.formatCardAsMarkdown(cardData);
      }
      return cardData;
    });
  }
  // Add Comment on Card
  async addCommentToCard(cardId, text) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post(
        `cards/${cardId}/actions/comments?text=${encodeURIComponent(text)}`
      );
      return response.data;
    });
  }
  // Update Comment
  async updateCommentOnCard(commentId, text) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(
        `/actions/${commentId}?text=${encodeURIComponent(text)}`
      );
      if (response.status !== 200) {
        return false;
      }
      return true;
    });
  }
  // Delete Comment
  async deleteCommentFromCard(commentId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.delete(`/actions/${commentId}`);
      return response.status === 200;
    });
  }
  // Get Card Comments
  async getCardComments(cardId, limit = 100) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/cards/${cardId}/actions`, {
        params: {
          filter: "commentCard",
          limit
        }
      });
      return response.data;
    });
  }
  // Checklist methods
  async getChecklistItems(name, cardId, boardId) {
    let checklists;
    if (cardId) {
      const cardResponse = await this.axiosInstance.get(`/cards/${cardId}`, {
        params: { checklists: "all" }
      });
      checklists = cardResponse.data.checklists || [];
    } else {
      const effectiveBoardId = boardId || this.activeConfig.boardId;
      if (!effectiveBoardId) {
        throw new McpError(ErrorCode.InvalidParams, "No board ID or card ID provided and no active board set");
      }
      const response = await this.axiosInstance.get(
        `/boards/${effectiveBoardId}/checklists`
      );
      checklists = response.data;
    }
    const allCheckItems = [];
    for (const checklist of checklists) {
      if (checklist.name.toLowerCase() === name.toLowerCase()) {
        const convertedItems = checklist.checkItems.map(
          (item) => this.convertToCheckListItem(item, checklist.id)
        );
        allCheckItems.push(...convertedItems);
      }
    }
    return allCheckItems;
  }
  async addChecklistItem(text, checkListName, cardId, boardId) {
    let checklists;
    if (cardId) {
      const cardResponse = await this.axiosInstance.get(`/cards/${cardId}`, {
        params: { checklists: "all" }
      });
      checklists = cardResponse.data.checklists || [];
    } else {
      const effectiveBoardId = boardId || this.activeConfig.boardId;
      if (!effectiveBoardId) {
        throw new McpError(ErrorCode.InvalidParams, "No board ID or card ID provided and no active board set");
      }
      const checklistsResponse = await this.axiosInstance.get(
        `/boards/${effectiveBoardId}/checklists`
      );
      checklists = checklistsResponse.data;
    }
    const targetChecklist = checklists.find(
      (checklist) => checklist.name.toLowerCase() === checkListName.toLowerCase()
    );
    if (!targetChecklist) {
      throw new McpError(ErrorCode.InvalidParams, `Checklist "${checkListName}" not found${cardId ? " on card" : " on board"}`);
    }
    const itemResponse = await this.axiosInstance.post(
      `/checklists/${targetChecklist.id}/checkItems`,
      {
        name: text
      }
    );
    return this.convertToCheckListItem(itemResponse.data, targetChecklist.id);
  }
  async findChecklistItemsByDescription(description, cardId, boardId) {
    let checklists;
    if (cardId) {
      const cardResponse = await this.axiosInstance.get(`/cards/${cardId}`, {
        params: { checklists: "all" }
      });
      checklists = cardResponse.data.checklists || [];
    } else {
      const effectiveBoardId = boardId || this.activeConfig.boardId;
      if (!effectiveBoardId) {
        throw new McpError(ErrorCode.InvalidParams, "No board ID or card ID provided and no active board set");
      }
      const response = await this.axiosInstance.get(
        `/boards/${effectiveBoardId}/checklists`
      );
      checklists = response.data;
    }
    const matchingItems = [];
    const searchTerm = description.toLowerCase();
    for (const checklist of checklists) {
      for (const checkItem of checklist.checkItems) {
        if (checkItem.name.toLowerCase().includes(searchTerm)) {
          matchingItems.push(this.convertToCheckListItem(checkItem, checklist.id));
        }
      }
    }
    return matchingItems;
  }
  async getAcceptanceCriteria(cardId, boardId) {
    return this.getChecklistItems("Acceptance Criteria", cardId, boardId);
  }
  async createChecklist(name, cardId) {
    if (!cardId) {
      throw new McpError(ErrorCode.InvalidParams, "No card ID provided and no active card set");
    }
    const response = await this.axiosInstance.post(`/cards/${cardId}/checklists`, { name });
    return response.data;
  }
  async getChecklistByName(name, cardId, boardId) {
    let checklists;
    if (cardId) {
      const cardResponse = await this.axiosInstance.get(`/cards/${cardId}`, {
        params: { checklists: "all" }
      });
      checklists = cardResponse.data.checklists || [];
    } else {
      const effectiveBoardId = boardId || this.activeConfig.boardId;
      if (!effectiveBoardId) {
        throw new McpError(ErrorCode.InvalidParams, "No board ID or card ID provided and no active board set");
      }
      const response = await this.axiosInstance.get(
        `/boards/${effectiveBoardId}/checklists`
      );
      checklists = response.data;
    }
    const targetChecklist = checklists.find(
      (checklist) => checklist.name.toLowerCase() === name.toLowerCase()
    );
    if (targetChecklist) {
      return this.convertToCheckList(targetChecklist);
    }
    return null;
  }
  /**
   * Update a checklist item state (complete/incomplete)
   */
  async updateChecklistItem(cardId, checkItemId, state) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.put(
        `/cards/${cardId}/checkItem/${checkItemId}`,
        {
          state
        }
      );
      return response.data;
    });
  }
  formatCardAsMarkdown(card) {
    let markdown = "";
    markdown += `# ${card.name}

`;
    if (card.board && card.list) {
      markdown += `\u{1F4CD} **Board**: [${card.board.name}](${card.board.url}) > **List**: ${card.list.name}

`;
    }
    if (card.labels && card.labels.length > 0) {
      markdown += `## \u{1F3F7}\uFE0F Labels
`;
      card.labels.forEach((label) => {
        markdown += `- \`${label.color}\` ${label.name || "(no name)"}
`;
      });
      markdown += "\n";
    }
    if (card.due) {
      const dueDate = new Date(card.due);
      const status = card.dueComplete ? "\u2705 Complete" : "\u23F0 Due";
      markdown += `## \u{1F4C5} Due Date
${status}: ${dueDate.toLocaleString()}

`;
    }
    if (card.members && card.members.length > 0) {
      markdown += `## \u{1F465} Members
`;
      card.members.forEach((member) => {
        markdown += `- @${member.username} (${member.fullName})
`;
      });
      markdown += "\n";
    }
    if (card.desc) {
      markdown += `## \u{1F4DD} Description
`;
      markdown += `${card.desc}

`;
      const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
      const images = card.desc.match(imageRegex);
      if (images) {
        markdown += `### Inline Images in Description
`;
        images.forEach((img, index) => {
          const match = img.match(/!\[([^\]]*)\]\(([^)]+)\)/);
          if (match) {
            markdown += `${index + 1}. ${match[1] || "Image"}: ${match[2]}
`;
          }
        });
        markdown += "\n";
      }
    }
    if (card.checklists && card.checklists.length > 0) {
      markdown += `## \u2705 Checklists
`;
      card.checklists.forEach((checklist) => {
        const completed = checklist.checkItems.filter((item) => item.state === "complete").length;
        const total = checklist.checkItems.length;
        markdown += `### ${checklist.name} (${completed}/${total})
`;
        const sortedItems = [...checklist.checkItems].sort((a, b) => a.pos - b.pos);
        sortedItems.forEach((item) => {
          const checkbox = item.state === "complete" ? "[x]" : "[ ]";
          markdown += `- ${checkbox} ${item.name}`;
          if (item.due) {
            const itemDue = new Date(item.due);
            markdown += ` (Due: ${itemDue.toLocaleDateString()})`;
          }
          if (item.idMember) {
            const member = card.members?.find((m) => m.id === item.idMember);
            if (member) {
              markdown += ` - @${member.username}`;
            }
          }
          markdown += "\n";
        });
        markdown += "\n";
      });
    }
    if (card.attachments && card.attachments.length > 0) {
      markdown += `## \u{1F4CE} Attachments (${card.attachments.length})
`;
      card.attachments.forEach((attachment, index) => {
        markdown += `### ${index + 1}. ${attachment.name}
`;
        markdown += `- **URL**: ${attachment.url}
`;
        if (attachment.fileName) {
          markdown += `- **File**: ${attachment.fileName}`;
          if (attachment.bytes) {
            const size = this.formatFileSize(attachment.bytes);
            markdown += ` (${size})`;
          }
          markdown += "\n";
        }
        if (attachment.mimeType) {
          markdown += `- **Type**: ${attachment.mimeType}
`;
        }
        markdown += `- **Added**: ${new Date(attachment.date).toLocaleString()}
`;
        if (attachment.previews && attachment.previews.length > 0) {
          const preview = attachment.previews[0];
          markdown += `- **Preview**: ![${attachment.name}](${preview.url})
`;
        }
        markdown += "\n";
      });
    }
    if (card.comments && card.comments.length > 0) {
      markdown += `## \u{1F4AC} Comments (${card.comments.length})
`;
      card.comments.forEach((comment) => {
        const date = new Date(comment.date);
        markdown += `### ${comment.memberCreator.fullName} (@${comment.memberCreator.username}) - ${date.toLocaleString()}
`;
        markdown += `${comment.data.text}

`;
      });
    }
    if (card.badges) {
      markdown += `## \u{1F4CA} Statistics
`;
      if (card.badges.checkItems > 0) {
        markdown += `- **Checklist Items**: ${card.badges.checkItemsChecked}/${card.badges.checkItems} completed
`;
      }
      if (card.badges.comments > 0) {
        markdown += `- **Comments**: ${card.badges.comments}
`;
      }
      if (card.badges.attachments > 0) {
        markdown += `- **Attachments**: ${card.badges.attachments}
`;
      }
      if (card.badges.votes > 0) {
        markdown += `- **Votes**: ${card.badges.votes}
`;
      }
      markdown += "\n";
    }
    markdown += `## \u{1F517} Links
`;
    markdown += `- **Card URL**: ${card.url}
`;
    markdown += `- **Short URL**: ${card.shortUrl}

`;
    markdown += `---
`;
    markdown += `*Last Activity: ${new Date(card.dateLastActivity).toLocaleString()}*
`;
    markdown += `*Card ID: ${card.id}*
`;
    return markdown;
  }
  formatFileSize(bytes) {
    const sizes = ["Bytes", "KB", "MB", "GB"];
    if (bytes === 0) return "0 Bytes";
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + " " + sizes[i];
  }
  // Helper methods to convert between Trello types and MCP types
  convertToCheckListItem(trelloItem, parentCheckListId) {
    return {
      id: trelloItem.id,
      text: trelloItem.name,
      complete: trelloItem.state === "complete",
      parentCheckListId
    };
  }
  convertToCheckList(trelloChecklist) {
    const completedItems = trelloChecklist.checkItems.filter(
      (item) => item.state === "complete"
    ).length;
    const totalItems = trelloChecklist.checkItems.length;
    const percentComplete = totalItems > 0 ? Math.round(completedItems / totalItems * 100) : 0;
    return {
      id: trelloChecklist.id,
      name: trelloChecklist.name,
      items: trelloChecklist.checkItems.map(
        (item) => this.convertToCheckListItem(item, trelloChecklist.id)
      ),
      percentComplete
    };
  }
  // Member management methods
  async getBoardMembers(boardId) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "boardId is required when no default board is configured"
      );
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/boards/${effectiveBoardId}/members`);
      return response.data;
    });
  }
  async assignMemberToCard(cardId, memberId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post(`/cards/${cardId}/idMembers`, {
        value: memberId
      });
      return response.data;
    });
  }
  async removeMemberFromCard(cardId, memberId) {
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.delete(`/cards/${cardId}/idMembers/${memberId}`);
      return response.data;
    });
  }
  // Label management methods
  async getBoardLabels(boardId) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "boardId is required when no default board is configured"
      );
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.get(`/boards/${effectiveBoardId}/labels`);
      return response.data;
    });
  }
  async createLabel(boardId, name, color) {
    const effectiveBoardId = boardId || this.activeConfig.boardId || this.defaultBoardId;
    if (!effectiveBoardId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "boardId is required when no default board is configured"
      );
    }
    return this.handleRequest(async () => {
      const response = await this.axiosInstance.post(`/boards/${effectiveBoardId}/labels`, {
        name,
        color
      });
      return response.data;
    });
  }
  async updateLabel(labelId, name, color) {
    return this.handleRequest(async () => {
      const updateData = {};
      if (name !== void 0) updateData.name = name;
      if (color !== void 0) updateData.color = color;
      const response = await this.axiosInstance.put(`/labels/${labelId}`, updateData);
      return response.data;
    });
  }
  async deleteLabel(labelId) {
    return this.handleRequest(async () => {
      await this.axiosInstance.delete(`/labels/${labelId}`);
      return true;
    });
  }
  // Card history method
  async getCardHistory(cardId, filter, limit) {
    return this.handleRequest(async () => {
      const params = {};
      if (filter) params.filter = filter;
      if (limit) params.limit = limit;
      const response = await this.axiosInstance.get(`/cards/${cardId}/actions`, { params });
      return response.data;
    });
  }
  /**
   * Download an attachment from a card with authentication
   * Returns base64-encoded data along with metadata
   */
  async downloadAttachment(cardId, attachmentId) {
    return this.handleRequest(async () => {
      const metaResponse = await this.axiosInstance.get(
        `/cards/${cardId}/attachments/${attachmentId}`
      );
      const attachment = metaResponse.data;
      const downloadUrl = `https://api.trello.com/1/cards/${cardId}/attachments/${attachmentId}/download/${encodeURIComponent(attachment.fileName)}`;
      await this.rateLimiter.waitForAvailableToken();
      const response = await axios.get(downloadUrl, {
        headers: {
          Authorization: `OAuth oauth_consumer_key="${this.config.apiKey}", oauth_token="${this.config.token}"`
        },
        responseType: "arraybuffer"
      });
      const base64Data = Buffer.from(response.data).toString("base64");
      return {
        data: base64Data,
        mimeType: attachment.mimeType || "application/octet-stream",
        fileName: attachment.fileName || "attachment"
      };
    });
  }
};
var MIME_TYPES = Object.freeze({
  // Images
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  // Documents
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Text
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".log": "text/plain",
  // Code
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".ts": "application/typescript",
  ".tsx": "application/typescript",
  ".jsx": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  // Archives
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  // Media
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".webm": "video/webm"
});

// src/health/health-monitor.ts
import { performance } from "perf_hooks";
var TrelloHealthMonitor = class {
  performanceTracker;
  lastHealthCheck;
  trelloClient;
  rateLimiter;
  // Will get injected from TrelloClient
  constructor(trelloClient) {
    this.trelloClient = trelloClient;
    this.performanceTracker = {
      requests: [],
      startTime: Date.now()
    };
    this.startPerformanceMonitoring();
  }
  /**
   * Get comprehensive system health status
   * This is the main cardiovascular examination! 🫀
   */
  async getSystemHealth(detailed = false) {
    const startTime = performance.now();
    const checks = [];
    const checkPromises = [
      this.checkTrelloApiConnectivity(),
      this.checkBoardAccess(),
      this.checkRateLimitHealth(),
      this.checkPerformanceMetrics()
    ];
    if (detailed) {
      checkPromises.push(
        this.checkListOperations(),
        this.checkCardOperations(),
        this.checkChecklistOperations(),
        this.checkWorkspaceAccess()
      );
    }
    try {
      const checkResults = await Promise.all(checkPromises);
      checks.push(...checkResults);
    } catch (error) {
      checks.push(await this.createErrorCheck("parallel_execution", error));
    }
    const overallStatus = this.calculateOverallStatus(checks);
    const recommendations = this.generateRecommendations(checks, overallStatus);
    const report = {
      overall_status: overallStatus,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      checks,
      recommendations,
      repair_available: this.isRepairAvailable(checks),
      uptime_ms: Date.now() - this.performanceTracker.startTime,
      performance_metrics: this.calculatePerformanceMetrics()
    };
    this.lastHealthCheck = report;
    return report;
  }
  /**
   * Check basic Trello API connectivity
   */
  async checkTrelloApiConnectivity() {
    const startTime = performance.now();
    const checkName = "trello_api_connectivity";
    try {
      await this.trelloClient.listBoards();
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, true);
      return {
        name: checkName,
        status: "healthy" /* HEALTHY */,
        message: "Trello API connectivity is excellent",
        duration_ms: Math.round(duration),
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        metadata: {
          endpoint: "/members/me/boards",
          response_time_category: this.categorizeResponseTime(duration)
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, false);
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  /**
   * Check if we can access the active board
   */
  async checkBoardAccess() {
    const startTime = performance.now();
    const checkName = "board_access";
    try {
      const boardId = this.trelloClient.activeBoardId;
      if (!boardId) {
        return {
          name: checkName,
          status: "degraded" /* DEGRADED */,
          message: "No active board configured",
          duration_ms: Math.round(performance.now() - startTime),
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          metadata: {
            suggestion: "Set an active board using set_active_board tool"
          }
        };
      }
      const board = await this.trelloClient.getBoardById(boardId);
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, true);
      return {
        name: checkName,
        status: board.closed ? "critical" /* CRITICAL */ : "healthy" /* HEALTHY */,
        message: board.closed ? "Active board is closed/archived" : `Board "${board.name}" is accessible`,
        duration_ms: Math.round(duration),
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        metadata: {
          board_id: board.id,
          board_name: board.name,
          board_closed: board.closed,
          board_url: board.url
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, false);
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  /**
   * Check rate limiter health and utilization
   */
  async checkRateLimitHealth() {
    const startTime = performance.now();
    const checkName = "rate_limit_health";
    try {
      const rateLimiterInfo = {
        can_make_request: true,
        // We'll approximate this
        utilization_percent: this.calculateRateLimitUtilization()
      };
      const duration = performance.now() - startTime;
      let status = "healthy" /* HEALTHY */;
      let message = "Rate limiting is functioning optimally";
      if (rateLimiterInfo.utilization_percent > 80) {
        status = "degraded" /* DEGRADED */;
        message = "High rate limit utilization detected";
      } else if (rateLimiterInfo.utilization_percent > 95) {
        status = "critical" /* CRITICAL */;
        message = "Rate limit near exhaustion";
      }
      return {
        name: checkName,
        status,
        message,
        duration_ms: Math.round(duration),
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        metadata: {
          utilization_percent: rateLimiterInfo.utilization_percent,
          can_make_request: rateLimiterInfo.can_make_request,
          trello_limits: {
            api_key_limit: "300 requests / 10 seconds",
            token_limit: "100 requests / 10 seconds"
          }
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  /**
   * Check performance metrics health
   */
  async checkPerformanceMetrics() {
    const startTime = performance.now();
    const checkName = "performance_metrics";
    try {
      const metrics = this.calculatePerformanceMetrics();
      const duration = performance.now() - startTime;
      let status = "healthy" /* HEALTHY */;
      let message = "Performance metrics are excellent";
      if (metrics.avg_response_time_ms > 2e3) {
        status = "degraded" /* DEGRADED */;
        message = "Slower than optimal response times detected";
      } else if (metrics.success_rate_percent < 95) {
        status = "critical" /* CRITICAL */;
        message = "Low success rate detected";
      }
      return {
        name: checkName,
        status,
        message,
        duration_ms: Math.round(duration),
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        metadata: {
          ...metrics,
          total_requests: this.performanceTracker.requests.length
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  /**
   * Check list operations (detailed check)
   */
  async checkListOperations() {
    const startTime = performance.now();
    const checkName = "list_operations";
    try {
      const lists = await this.trelloClient.getLists();
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, true);
      return {
        name: checkName,
        status: "healthy" /* HEALTHY */,
        message: `Successfully retrieved ${lists.length} lists`,
        duration_ms: Math.round(duration),
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        metadata: {
          total_lists: lists.length,
          open_lists: lists.filter((l) => !l.closed).length,
          closed_lists: lists.filter((l) => l.closed).length
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, false);
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  /**
   * Check card operations (detailed check)
   */
  async checkCardOperations() {
    const startTime = performance.now();
    const checkName = "card_operations";
    try {
      const myCards = await this.trelloClient.getMyCards();
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, true);
      return {
        name: checkName,
        status: "healthy" /* HEALTHY */,
        message: `Successfully retrieved ${myCards.length} user cards`,
        duration_ms: Math.round(duration),
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        metadata: {
          total_cards: myCards.length,
          open_cards: myCards.filter((c) => !c.closed).length,
          closed_cards: myCards.filter((c) => c.closed).length
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, false);
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  /**
   * Check checklist operations (detailed check)
   */
  async checkChecklistOperations() {
    const startTime = performance.now();
    const checkName = "checklist_operations";
    try {
      const criteria = await this.trelloClient.getAcceptanceCriteria();
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, true);
      return {
        name: checkName,
        status: "healthy" /* HEALTHY */,
        message: `Checklist operations functioning (${criteria.length} acceptance criteria found)`,
        duration_ms: Math.round(duration),
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        metadata: {
          acceptance_criteria_count: criteria.length,
          completed_items: criteria.filter((item) => item.complete).length
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, false);
      const isConfigError = error instanceof Error && (error.message.includes("not found") || error.message.includes("No board ID"));
      return this.createErrorCheck(
        checkName,
        error,
        duration,
        isConfigError ? "degraded" /* DEGRADED */ : "critical" /* CRITICAL */
      );
    }
  }
  /**
   * Check workspace access (detailed check)
   */
  async checkWorkspaceAccess() {
    const startTime = performance.now();
    const checkName = "workspace_access";
    try {
      const workspaces = await this.trelloClient.listWorkspaces();
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, true);
      return {
        name: checkName,
        status: "healthy" /* HEALTHY */,
        message: `Access to ${workspaces.length} workspaces confirmed`,
        duration_ms: Math.round(duration),
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        metadata: {
          total_workspaces: workspaces.length,
          active_workspace_id: this.trelloClient.activeWorkspaceId,
          workspace_names: workspaces.map((w) => w.displayName)
        }
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordPerformanceMetric(duration, false);
      return this.createErrorCheck(checkName, error, duration);
    }
  }
  /**
   * Calculate overall system health status
   */
  calculateOverallStatus(checks) {
    if (checks.some((c) => c.status === "critical" /* CRITICAL */)) {
      return "critical" /* CRITICAL */;
    }
    if (checks.some((c) => c.status === "degraded" /* DEGRADED */)) {
      return "degraded" /* DEGRADED */;
    }
    if (checks.every((c) => c.status === "healthy" /* HEALTHY */)) {
      return "healthy" /* HEALTHY */;
    }
    return "unknown" /* UNKNOWN */;
  }
  /**
   * Generate health-based recommendations
   */
  generateRecommendations(checks, overallStatus) {
    const recommendations = [];
    const boardCheck = checks.find((c) => c.name === "board_access");
    if (boardCheck?.status === "degraded" /* DEGRADED */ && boardCheck.metadata?.suggestion) {
      recommendations.push(boardCheck.metadata.suggestion);
    }
    const rateLimitCheck = checks.find((c) => c.name === "rate_limit_health");
    if (rateLimitCheck?.status === "degraded" /* DEGRADED */) {
      recommendations.push(
        "Consider implementing request throttling or caching to reduce API usage"
      );
    }
    const performanceCheck = checks.find((c) => c.name === "performance_metrics");
    if (performanceCheck?.status === "degraded" /* DEGRADED */) {
      recommendations.push(
        "Investigate slow response times - consider network conditions or API load"
      );
    }
    if (overallStatus === "healthy" /* HEALTHY */) {
      recommendations.push("All systems operating normally - maintain current configuration");
    } else if (overallStatus === "critical" /* CRITICAL */) {
      recommendations.push("Immediate attention required - check error logs and connectivity");
    }
    return recommendations.length > 0 ? recommendations : ["System assessment complete - no specific recommendations"];
  }
  /**
   * Check if repair functionality is available
   */
  isRepairAvailable(checks) {
    return checks.some((c) => c.status === "degraded" /* DEGRADED */) && !checks.some((c) => c.status === "critical" /* CRITICAL */);
  }
  /**
   * Create a standardized error check result
   */
  createErrorCheck(checkName, error, duration, status = "critical" /* CRITICAL */) {
    let message = "Unknown error occurred";
    let errorCode;
    if (error instanceof Error) {
      message = error.message;
    }
    if (error && typeof error === "object" && "response" in error) {
      const axiosError = error;
      errorCode = axiosError.response?.status?.toString();
      message = `HTTP ${axiosError.response?.status}: ${axiosError.message}`;
    }
    return {
      name: checkName,
      status,
      message,
      duration_ms: Math.round(duration || 0),
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      metadata: {
        error_type: error?.constructor?.name || "Unknown",
        error_code: errorCode,
        error_details: error instanceof Error ? error.stack : void 0
      }
    };
  }
  /**
   * Record performance metrics for tracking
   */
  recordPerformanceMetric(duration, success) {
    const now = Date.now();
    this.performanceTracker.requests.push({ timestamp: now, duration, success });
    if (this.performanceTracker.requests.length > 100) {
      this.performanceTracker.requests = this.performanceTracker.requests.slice(-100);
    }
  }
  /**
   * Calculate comprehensive performance metrics
   */
  calculatePerformanceMetrics() {
    const requests = this.performanceTracker.requests;
    if (requests.length === 0) {
      return {
        avg_response_time_ms: 0,
        success_rate_percent: 100,
        rate_limit_utilization_percent: 0,
        requests_per_minute: 0
      };
    }
    const avgResponseTime = requests.reduce((sum, r) => sum + r.duration, 0) / requests.length;
    const successRate = requests.filter((r) => r.success).length / requests.length * 100;
    const oneMinuteAgo = Date.now() - 6e4;
    const recentRequests = requests.filter((r) => r.timestamp > oneMinuteAgo);
    const requestsPerMinute = recentRequests.length;
    return {
      avg_response_time_ms: Math.round(avgResponseTime),
      success_rate_percent: Math.round(successRate * 100) / 100,
      rate_limit_utilization_percent: this.calculateRateLimitUtilization(),
      requests_per_minute: requestsPerMinute
    };
  }
  /**
   * Calculate rate limit utilization (approximation)
   */
  calculateRateLimitUtilization() {
    const requests = this.performanceTracker.requests;
    const tenSecondsAgo = Date.now() - 1e4;
    const recentRequests = requests.filter((r) => r.timestamp > tenSecondsAgo).length;
    return Math.min(100, recentRequests / 100 * 100);
  }
  /**
   * Categorize response times for reporting
   */
  categorizeResponseTime(duration) {
    if (duration < 200) return "excellent";
    if (duration < 500) return "good";
    if (duration < 1e3) return "fair";
    if (duration < 2e3) return "slow";
    return "very_slow";
  }
  /**
   * Start background performance monitoring
   */
  startPerformanceMonitoring() {
    setInterval(() => {
      const fiveMinutesAgo = Date.now() - 3e5;
      this.performanceTracker.requests = this.performanceTracker.requests.filter(
        (r) => r.timestamp > fiveMinutesAgo
      );
    }, 6e4);
  }
  /**
   * Get the last health check result
   */
  getLastHealthCheck() {
    return this.lastHealthCheck;
  }
};

// src/health/health-endpoints.ts
var TrelloHealthEndpoints = class {
  healthMonitor;
  trelloClient;
  constructor(trelloClient) {
    this.trelloClient = trelloClient;
    this.healthMonitor = new TrelloHealthMonitor(trelloClient);
  }
  /**
   * GET /health
   * Quick health status check - the digital pulse check!
   * Perfect for load balancers and monitoring systems.
   */
  async getBasicHealth() {
    try {
      const healthReport = await this.healthMonitor.getSystemHealth(false);
      const quickReport = {
        status: healthReport.overall_status,
        timestamp: healthReport.timestamp,
        uptime_ms: healthReport.uptime_ms,
        checks_passed: healthReport.checks.filter((c) => c.status === "healthy" /* HEALTHY */).length,
        total_checks: healthReport.checks.length,
        response_time_ms: Math.round(healthReport.performance_metrics.avg_response_time_ms),
        success_rate: `${healthReport.performance_metrics.success_rate_percent}%`
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(quickReport, null, 2)
          }
        ],
        isError: healthReport.overall_status === "critical" /* CRITICAL */
      };
    } catch (error) {
      return this.createErrorResponse("Health check failed", error);
    }
  }
  /**
   * GET /health/detailed
   * Comprehensive health diagnostic - the full medical examination!
   * Includes all subsystem checks, performance metrics, and recommendations.
   */
  async getDetailedHealth() {
    try {
      const healthReport = await this.healthMonitor.getSystemHealth(true);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(healthReport, null, 2)
          }
        ],
        isError: healthReport.overall_status === "critical" /* CRITICAL */
      };
    } catch (error) {
      return this.createErrorResponse("Detailed health check failed", error);
    }
  }
  /**
   * GET /health/metadata
   * Metadata consistency verification - the data integrity scanner!
   * Checks for consistency between boards, lists, cards, and checklists.
   */
  async getMetadataHealth() {
    try {
      const startTime = Date.now();
      const metadataReport = await this.performMetadataConsistencyCheck();
      const duration = Date.now() - startTime;
      const result = {
        status: metadataReport.consistent ? "healthy" /* HEALTHY */ : "degraded" /* DEGRADED */,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        duration_ms: duration,
        metadata_consistency: metadataReport,
        recommendations: this.generateMetadataRecommendations(metadataReport)
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ],
        isError: !metadataReport.consistent
      };
    } catch (error) {
      return this.createErrorResponse("Metadata health check failed", error);
    }
  }
  /**
   * GET /health/performance
   * Performance metrics analysis - the cardiovascular stress test!
   * Deep dive into response times, throughput, and system efficiency.
   */
  async getPerformanceHealth() {
    try {
      const healthReport = await this.healthMonitor.getSystemHealth(false);
      const performanceAnalysis = this.analyzePerformanceMetrics(healthReport);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(performanceAnalysis, null, 2)
          }
        ],
        isError: performanceAnalysis.status === "critical" /* CRITICAL */
      };
    } catch (error) {
      return this.createErrorResponse("Performance health check failed", error);
    }
  }
  /**
   * POST /admin/repair
   * Automated system repair - the digital emergency room!
   * Attempts to automatically fix common issues when possible.
   */
  async performRepair() {
    try {
      const healthReport = await this.healthMonitor.getSystemHealth(true);
      if (!healthReport.repair_available) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  repair_attempted: false,
                  reason: "No repairable issues detected or system in critical state",
                  status: healthReport.overall_status,
                  recommendations: healthReport.recommendations
                },
                null,
                2
              )
            }
          ]
        };
      }
      const repairResult = await this.attemptSystemRepair(healthReport);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(repairResult, null, 2)
          }
        ],
        isError: !repairResult.success
      };
    } catch (error) {
      return this.createErrorResponse("System repair failed", error);
    }
  }
  /**
   * Perform comprehensive metadata consistency check
   */
  async performMetadataConsistencyCheck() {
    const results = {
      consistent: true,
      issues: [],
      statistics: {},
      last_check: (/* @__PURE__ */ new Date()).toISOString()
    };
    try {
      const boardId = this.trelloClient.activeBoardId;
      if (!boardId) {
        results.consistent = false;
        results.issues.push("No active board configured");
        return results;
      }
      const board = await this.trelloClient.getBoardById(boardId);
      if (board.closed) {
        results.consistent = false;
        results.issues.push("Active board is closed/archived");
      }
      const lists = await this.trelloClient.getLists();
      results.statistics.total_lists = lists.length;
      results.statistics.open_lists = lists.filter((l) => !l.closed).length;
      results.statistics.closed_lists = lists.filter((l) => l.closed).length;
      if (lists.length === 0) {
        results.issues.push("Board has no lists");
      }
      const myCards = await this.trelloClient.getMyCards();
      results.statistics.total_user_cards = myCards.length;
      results.statistics.open_user_cards = myCards.filter((c) => !c.closed).length;
      const workspaceId = this.trelloClient.activeWorkspaceId;
      if (workspaceId) {
        try {
          const workspace = await this.trelloClient.getWorkspaceById(workspaceId);
          results.statistics.active_workspace = workspace.displayName;
        } catch (error) {
          results.consistent = false;
          results.issues.push("Active workspace is inaccessible");
        }
      }
      try {
        const acceptanceCriteria = await this.trelloClient.getAcceptanceCriteria();
        results.statistics.acceptance_criteria_items = acceptanceCriteria.length;
      } catch (error) {
        results.statistics.checklist_note = "Acceptance Criteria checklist not found (non-critical)";
      }
    } catch (error) {
      results.consistent = false;
      results.issues.push(
        `Metadata check error: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
    return results;
  }
  /**
   * Generate metadata-specific recommendations
   */
  generateMetadataRecommendations(metadataReport) {
    const recommendations = [];
    if (metadataReport.issues.some((issue) => issue.includes("No active board"))) {
      recommendations.push("Use set_active_board tool to configure an active board");
    }
    if (metadataReport.issues.some((issue) => issue.includes("closed/archived"))) {
      recommendations.push("Set a different active board that is not closed/archived");
    }
    if (metadataReport.issues.some((issue) => issue.includes("no lists"))) {
      recommendations.push("Create lists in your board using add_list_to_board tool");
    }
    if (metadataReport.statistics.total_user_cards === 0) {
      recommendations.push(
        "Consider assigning yourself to some cards for better workflow tracking"
      );
    }
    if (recommendations.length === 0) {
      recommendations.push("Metadata consistency is excellent - no action required");
    }
    return recommendations;
  }
  /**
   * Analyze performance metrics in detail
   */
  analyzePerformanceMetrics(healthReport) {
    const metrics = healthReport.performance_metrics;
    const performanceGrade = this.calculatePerformanceGrade(metrics);
    return {
      status: this.getPerformanceStatus(performanceGrade),
      timestamp: healthReport.timestamp,
      performance_grade: performanceGrade,
      metrics: {
        ...metrics,
        uptime_hours: Math.round(healthReport.uptime_ms / (1e3 * 60 * 60) * 100) / 100,
        health_check_duration_ms: healthReport.checks.reduce((sum, c) => sum + c.duration_ms, 0)
      },
      analysis: {
        response_time_rating: this.rateResponseTime(metrics.avg_response_time_ms),
        success_rate_rating: this.rateSuccessRate(metrics.success_rate_percent),
        throughput_rating: this.rateThroughput(metrics.requests_per_minute),
        rate_limit_health: this.rateRateLimitUtilization(metrics.rate_limit_utilization_percent)
      },
      recommendations: this.generatePerformanceRecommendations(metrics)
    };
  }
  /**
   * Calculate overall performance grade
   */
  calculatePerformanceGrade(metrics) {
    let score = 0;
    if (metrics.avg_response_time_ms < 200) score += 40;
    else if (metrics.avg_response_time_ms < 500) score += 35;
    else if (metrics.avg_response_time_ms < 1e3) score += 25;
    else if (metrics.avg_response_time_ms < 2e3) score += 15;
    else score += 5;
    if (metrics.success_rate_percent >= 99) score += 35;
    else if (metrics.success_rate_percent >= 95) score += 30;
    else if (metrics.success_rate_percent >= 90) score += 20;
    else if (metrics.success_rate_percent >= 80) score += 10;
    else score += 5;
    if (metrics.rate_limit_utilization_percent < 50) score += 25;
    else if (metrics.rate_limit_utilization_percent < 70) score += 20;
    else if (metrics.rate_limit_utilization_percent < 85) score += 15;
    else if (metrics.rate_limit_utilization_percent < 95) score += 10;
    else score += 5;
    if (score >= 90) return "A+";
    if (score >= 80) return "A";
    if (score >= 70) return "B";
    if (score >= 60) return "C";
    if (score >= 50) return "D";
    return "F";
  }
  /**
   * Get performance status based on grade
   */
  getPerformanceStatus(grade) {
    if (["A+", "A", "B"].includes(grade)) return "healthy" /* HEALTHY */;
    if (["C", "D"].includes(grade)) return "degraded" /* DEGRADED */;
    return "critical" /* CRITICAL */;
  }
  /**
   * Rate individual performance aspects
   */
  rateResponseTime(avgMs) {
    if (avgMs < 200) return "excellent";
    if (avgMs < 500) return "good";
    if (avgMs < 1e3) return "fair";
    if (avgMs < 2e3) return "slow";
    return "very_slow";
  }
  rateSuccessRate(percent) {
    if (percent >= 99) return "excellent";
    if (percent >= 95) return "good";
    if (percent >= 90) return "fair";
    if (percent >= 80) return "poor";
    return "critical";
  }
  rateThroughput(requestsPerMin) {
    if (requestsPerMin > 30) return "high";
    if (requestsPerMin > 15) return "moderate";
    if (requestsPerMin > 5) return "low";
    return "very_low";
  }
  rateRateLimitUtilization(percent) {
    if (percent < 50) return "optimal";
    if (percent < 70) return "moderate";
    if (percent < 85) return "high";
    if (percent < 95) return "near_limit";
    return "critical";
  }
  /**
   * Generate performance-specific recommendations
   */
  generatePerformanceRecommendations(metrics) {
    const recommendations = [];
    if (metrics.avg_response_time_ms > 1e3) {
      recommendations.push(
        "High response times detected - check network connectivity and Trello API status"
      );
    }
    if (metrics.success_rate_percent < 95) {
      recommendations.push(
        "Low success rate - investigate error patterns and implement retry logic"
      );
    }
    if (metrics.rate_limit_utilization_percent > 80) {
      recommendations.push(
        "High rate limit utilization - consider implementing request caching or batching"
      );
    }
    if (metrics.requests_per_minute < 1) {
      recommendations.push("Very low API usage - ensure the MCP server is being actively used");
    }
    if (recommendations.length === 0) {
      recommendations.push("Performance is excellent - maintain current usage patterns");
    }
    return recommendations;
  }
  /**
   * Attempt to repair common system issues
   */
  async attemptSystemRepair(healthReport) {
    const result = {
      attempted: true,
      success: false,
      actions_taken: [],
      message: ""
    };
    try {
      const boardCheck = healthReport.checks.find((c) => c.name === "board_access");
      if (boardCheck?.status === "degraded" /* DEGRADED */ && boardCheck.message.includes("No active board configured")) {
        const boards = await this.trelloClient.listBoards();
        const openBoards = boards.filter((b) => !b.closed);
        if (openBoards.length > 0) {
          await this.trelloClient.setActiveBoard(openBoards[0].id);
          result.actions_taken.push(`Set active board to "${openBoards[0].name}"`);
        }
      }
      result.success = result.actions_taken.length > 0;
      result.message = result.success ? "System repair completed successfully" : "No repairable issues found";
    } catch (error) {
      result.success = false;
      result.message = `Repair failed: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
    return result;
  }
  /**
   * Create standardized error response
   */
  createErrorResponse(message, error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: message,
              details: errorMessage,
              timestamp: (/* @__PURE__ */ new Date()).toISOString(),
              status: "critical" /* CRITICAL */
            },
            null,
            2
          )
        }
      ],
      isError: true
    };
  }
};
var HealthEndpointSchemas = {
  basicHealth: {
    title: "Get Basic Health",
    description: "Get quick system health status for monitoring and load balancing",
    inputSchema: {}
  },
  detailedHealth: {
    title: "Get Detailed Health",
    description: "Get comprehensive system health diagnostic with all subsystem checks",
    inputSchema: {}
  },
  metadataHealth: {
    title: "Get Metadata Health",
    description: "Verify metadata consistency between boards, lists, cards, and checklists",
    inputSchema: {}
  },
  performanceHealth: {
    title: "Get Performance Health",
    description: "Get detailed performance metrics and analysis",
    inputSchema: {}
  },
  repair: {
    title: "Perform System Repair",
    description: "Attempt to automatically repair common system issues",
    inputSchema: {}
  }
};

// src/index.ts
var TrelloServer = class {
  server;
  trelloClient;
  healthEndpoints;
  constructor() {
    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;
    const defaultBoardId = process.env.TRELLO_BOARD_ID;
    if (!apiKey || !token) {
      throw new Error("TRELLO_API_KEY and TRELLO_TOKEN environment variables are required");
    }
    this.trelloClient = new TrelloClient({
      apiKey,
      token,
      defaultBoardId,
      boardId: defaultBoardId
    });
    this.healthEndpoints = new TrelloHealthEndpoints(this.trelloClient);
    this.server = new McpServer({
      name: "trello-server",
      version: "1.0.0"
    });
    this.setupTools();
    this.setupHealthEndpoints();
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }
  handleError(error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`
        }
      ],
      isError: true
    };
  }
  setupTools() {
    this.server.registerTool(
      "get_cards_by_list_id",
      {
        title: "Get Cards by List ID",
        description: "Fetch cards from a specific Trello list on a specific board",
        inputSchema: {
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
          listId: z.string().describe("ID of the Trello list")
        }
      },
      async ({ boardId, listId }) => {
        try {
          const cards = await this.trelloClient.getCardsByList(boardId, listId);
          return {
            content: [{ type: "text", text: JSON.stringify(cards, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_lists",
      {
        title: "Get Lists",
        description: "Retrieve all lists from the specified board",
        inputSchema: {
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
        }
      },
      async ({ boardId }) => {
        try {
          const lists = await this.trelloClient.getLists(boardId);
          return {
            content: [{ type: "text", text: JSON.stringify(lists, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_recent_activity",
      {
        title: "Get Recent Activity",
        description: "Fetch recent activity on the Trello board",
        inputSchema: {
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
          limit: z.number().optional().default(10).describe("Number of activities to fetch (default: 10)")
        }
      },
      async ({ boardId, limit }) => {
        try {
          const activity = await this.trelloClient.getRecentActivity(boardId, limit);
          return {
            content: [{ type: "text", text: JSON.stringify(activity, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "add_card_to_list",
      {
        title: "Add Card to List",
        description: "Add a new card to a specified list on a specific board",
        inputSchema: {
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
          listId: z.string().describe("ID of the list to add the card to"),
          name: z.string().describe("Name of the card"),
          description: z.string().optional().describe("Description of the card"),
          dueDate: z.string().optional().describe("Due date for the card (ISO 8601 format)"),
          start: z.string().optional().describe("Start date for the card (YYYY-MM-DD format, date only)"),
          labels: z.array(z.string()).optional().describe("Array of label IDs to apply to the card")
        }
      },
      async (args) => {
        try {
          const card = await this.trelloClient.addCard(args.boardId, args);
          return {
            content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "update_card_details",
      {
        title: "Update Card Details",
        description: "Update an existing card's details on a specific board",
        inputSchema: {
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
          cardId: z.string().describe("ID of the card to update"),
          name: z.string().optional().describe("New name for the card"),
          description: z.string().optional().describe("New description for the card"),
          dueDate: z.string().optional().describe("New due date for the card (ISO 8601 format)"),
          start: z.string().optional().describe("New start date for the card (YYYY-MM-DD format, date only)"),
          dueComplete: z.boolean().optional().describe("Mark the due date as complete (true) or incomplete (false)"),
          labels: z.array(z.string()).optional().describe("New array of label IDs for the card")
        }
      },
      async (args) => {
        try {
          const card = await this.trelloClient.updateCard(args.boardId, args);
          return {
            content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "archive_card",
      {
        title: "Archive Card",
        description: "Send a card to the archive on a specific board",
        inputSchema: {
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
          cardId: z.string().describe("ID of the card to archive")
        }
      },
      async ({ boardId, cardId }) => {
        try {
          const card = await this.trelloClient.archiveCard(boardId, cardId);
          return {
            content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "move_card",
      {
        title: "Move Card",
        description: "Move a card to a different list, potentially on a different board",
        inputSchema: {
          boardId: z.string().optional().describe(
            "ID of the target Trello board (where the listId resides, uses default if not provided)"
          ),
          cardId: z.string().describe("ID of the card to move"),
          listId: z.string().describe("ID of the target list")
        }
      },
      async ({ boardId, cardId, listId }) => {
        try {
          const card = await this.trelloClient.moveCard(boardId, cardId, listId);
          return {
            content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "add_list_to_board",
      {
        title: "Add List to Board",
        description: "Add a new list to the specified board",
        inputSchema: {
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
          name: z.string().describe("Name of the new list")
        }
      },
      async ({ boardId, name }) => {
        try {
          const list = await this.trelloClient.addList(boardId, name);
          return {
            content: [{ type: "text", text: JSON.stringify(list, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "archive_list",
      {
        title: "Archive List",
        description: "Send a list to the archive on a specific board",
        inputSchema: {
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
          listId: z.string().describe("ID of the list to archive")
        }
      },
      async ({ boardId, listId }) => {
        try {
          const list = await this.trelloClient.archiveList(boardId, listId);
          return {
            content: [{ type: "text", text: JSON.stringify(list, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_my_cards",
      {
        title: "Get My Cards",
        description: "Fetch all cards assigned to the current user",
        inputSchema: {}
      },
      async () => {
        try {
          const cards = await this.trelloClient.getMyCards();
          return {
            content: [{ type: "text", text: JSON.stringify(cards, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "attach_image_to_card",
      {
        title: "Attach Image to Card",
        description: "Attach an image to a card from a URL on a specific board",
        inputSchema: {
          boardId: z.string().optional().describe(
            "ID of the Trello board where the card exists (uses default if not provided)"
          ),
          cardId: z.string().describe("ID of the card to attach the image to"),
          imageUrl: z.string().describe("URL of the image to attach"),
          name: z.string().optional().default("Image Attachment").describe('Optional name for the attachment (defaults to "Image Attachment")')
        }
      },
      async ({ boardId, cardId, imageUrl, name }) => {
        try {
          const attachment = await this.trelloClient.attachImageToCard(
            boardId,
            cardId,
            imageUrl,
            name
          );
          return {
            content: [{ type: "text", text: JSON.stringify(attachment, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "attach_file_to_card",
      {
        title: "Attach File to Card",
        description: "Attach any file to a card from a URL on a specific board",
        inputSchema: {
          boardId: z.string().optional().describe(
            "ID of the Trello board where the card exists (uses default if not provided)"
          ),
          cardId: z.string().describe("ID of the card to attach the file to"),
          fileUrl: z.string().describe("URL of the file to attach"),
          name: z.string().optional().default("File Attachment").describe('Optional name for the attachment (defaults to "File Attachment")'),
          mimeType: z.string().optional().describe(
            'Optional MIME type of the file (e.g., "application/pdf", "text/plain", "video/mp4")'
          )
        }
      },
      async ({ boardId, cardId, fileUrl, name, mimeType }) => {
        try {
          const attachment = await this.trelloClient.attachFileToCard(
            boardId,
            cardId,
            fileUrl,
            name,
            mimeType
          );
          return {
            content: [{ type: "text", text: JSON.stringify(attachment, null, 2) }]
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`
              }
            ],
            isError: true
          };
        }
      }
    );
    this.server.registerTool(
      "attach_image_data_to_card",
      {
        title: "Attach Image Data to Card",
        description: "Attach an image to a card from base64 data or data URL (for screenshot uploads)",
        inputSchema: {
          boardId: z.string().optional().describe(
            "ID of the Trello board where the card exists (uses default if not provided)"
          ),
          cardId: z.string().describe("ID of the card to attach the image to"),
          imageData: z.string().describe("Base64 encoded image data or data URL (e.g., data:image/png;base64,...)"),
          name: z.string().optional().describe("Optional name for the attachment"),
          mimeType: z.string().optional().default("image/png").describe("Optional MIME type (default: image/png)")
        }
      },
      async ({ boardId, cardId, imageData, name, mimeType }) => {
        try {
          const attachment = await this.trelloClient.attachImageDataToCard(
            boardId,
            cardId,
            imageData,
            name,
            mimeType
          );
          return {
            content: [{ type: "text", text: JSON.stringify(attachment, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "list_boards",
      {
        title: "List Boards",
        description: "List all boards the user has access to",
        inputSchema: {}
      },
      async () => {
        try {
          const boards = await this.trelloClient.listBoards();
          return {
            content: [{ type: "text", text: JSON.stringify(boards, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "set_active_board",
      {
        title: "Set Active Board",
        description: "Set the active board for future operations",
        inputSchema: {
          boardId: z.string().describe("ID of the board to set as active")
        }
      },
      async ({ boardId }) => {
        try {
          const board = await this.trelloClient.setActiveBoard(boardId);
          return {
            content: [
              {
                type: "text",
                text: `Successfully set active board to "${board.name}" (${board.id})`
              }
            ]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "list_workspaces",
      {
        title: "List Workspaces",
        description: "List all workspaces the user has access to",
        inputSchema: {}
      },
      async () => {
        try {
          const workspaces = await this.trelloClient.listWorkspaces();
          return {
            content: [{ type: "text", text: JSON.stringify(workspaces, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "create_board",
      {
        title: "Create Board",
        description: "Create a new Trello board optionally within a workspace",
        inputSchema: {
          name: z.string().describe("Name of the board"),
          desc: z.string().optional().describe("Description of the board"),
          idOrganization: z.string().min(1).optional().describe("Workspace ID to create the board in (uses active if not provided)"),
          defaultLabels: z.boolean().optional().default(true).describe("Create default labels (true by default)"),
          defaultLists: z.boolean().optional().default(true).describe("Create default lists (true by default)")
        }
      },
      async ({ name, desc, idOrganization, defaultLabels, defaultLists }) => {
        try {
          const board = await this.trelloClient.createBoard({
            name,
            desc,
            idOrganization,
            defaultLabels,
            defaultLists
          });
          return {
            content: [{ type: "text", text: JSON.stringify(board, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "set_active_workspace",
      {
        title: "Set Active Workspace",
        description: "Set the active workspace for future operations",
        inputSchema: {
          workspaceId: z.string().describe("ID of the workspace to set as active")
        }
      },
      async ({ workspaceId }) => {
        try {
          const workspace = await this.trelloClient.setActiveWorkspace(workspaceId);
          return {
            content: [
              {
                type: "text",
                text: `Successfully set active workspace to "${workspace.displayName}" (${workspace.id})`
              }
            ]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "list_boards_in_workspace",
      {
        title: "List Boards in Workspace",
        description: "List all boards in a specific workspace",
        inputSchema: {
          workspaceId: z.string().describe("ID of the workspace to list boards from")
        }
      },
      async ({ workspaceId }) => {
        try {
          const boards = await this.trelloClient.listBoardsInWorkspace(workspaceId);
          return {
            content: [{ type: "text", text: JSON.stringify(boards, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_active_board_info",
      {
        title: "Get Active Board Info",
        description: "Get information about the currently active board",
        inputSchema: {}
      },
      async () => {
        try {
          const boardId = this.trelloClient.activeBoardId;
          if (!boardId) {
            return {
              content: [{ type: "text", text: "No active board set" }],
              isError: true
            };
          }
          const board = await this.trelloClient.getBoardById(boardId);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ...board,
                    isActive: true,
                    activeWorkspaceId: this.trelloClient.activeWorkspaceId || "Not set"
                  },
                  null,
                  2
                )
              }
            ]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_card",
      {
        title: "Get Card",
        description: "Get detailed information about a specific Trello card",
        inputSchema: {
          cardId: z.string().describe("ID of the card to fetch"),
          includeMarkdown: z.boolean().optional().default(false).describe("Whether to return card description in markdown format (default: false)")
        }
      },
      async ({ cardId, includeMarkdown }) => {
        try {
          const card = await this.trelloClient.getCard(cardId, includeMarkdown);
          return {
            content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "add_comment",
      {
        title: "Add Comment to Card",
        description: "Add the given text as a new comment to the given card",
        inputSchema: {
          cardId: z.string().describe("ID of the card to comment on"),
          text: z.string().describe("The text of the comment to add")
        }
      },
      async ({ cardId, text }) => {
        try {
          const comment = await this.trelloClient.addCommentToCard(cardId, text);
          return {
            content: [{ type: "text", text: JSON.stringify(comment, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "update_comment",
      {
        title: "Update Comment on Card",
        description: "Update the given comment with the new text",
        inputSchema: {
          commentId: z.string().describe("ID of the comment to change"),
          text: z.string().describe("The new text of the comment")
        }
      },
      async ({ commentId, text }) => {
        try {
          const success = await this.trelloClient.updateCommentOnCard(commentId, text);
          return {
            content: [{ type: "text", text: success ? "success" : "failure" }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "delete_comment",
      {
        title: "Delete Comment from Card",
        description: "Delete a comment from a Trello card",
        inputSchema: {
          commentId: z.string().describe("ID of the comment to delete")
        }
      },
      async ({ commentId }) => {
        try {
          const success = await this.trelloClient.deleteCommentFromCard(commentId);
          return {
            content: [{ type: "text", text: success ? "success" : "failure" }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_card_comments",
      {
        title: "Get Card Comments",
        description: "Retrieve all comments from a specific Trello card",
        inputSchema: {
          cardId: z.string().describe("ID of the card to get comments from"),
          limit: z.number().optional().default(100).describe("Maximum number of comments to retrieve (default: 100)")
        }
      },
      async ({ cardId, limit }) => {
        try {
          const comments = await this.trelloClient.getCardComments(cardId, limit);
          return {
            content: [{ type: "text", text: JSON.stringify(comments, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "create_checklist",
      {
        title: "Create Checklist",
        description: "Create a new checklist",
        inputSchema: {
          name: z.string().describe("Name of the checklist to create"),
          cardId: z.string().describe("ID of the Trello card")
        }
      },
      async ({ name, cardId }) => {
        try {
          const items = await this.trelloClient.createChecklist(name, cardId);
          return {
            content: [{ type: "text", text: JSON.stringify(items, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_checklist_items",
      {
        title: "Get Checklist Items",
        description: "Get all items from a checklist by name",
        inputSchema: {
          name: z.string().describe("Name of the checklist to retrieve items from"),
          cardId: z.string().optional().describe("ID of the card to scope checklist search to (recommended to avoid ambiguity)"),
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
        }
      },
      async ({ name, cardId, boardId }) => {
        try {
          const items = await this.trelloClient.getChecklistItems(name, cardId, boardId);
          return {
            content: [{ type: "text", text: JSON.stringify(items, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "add_checklist_item",
      {
        title: "Add Checklist Item",
        description: "Add a new item to a checklist",
        inputSchema: {
          text: z.string().describe("Text content of the checklist item"),
          checkListName: z.string().describe("Name of the checklist to add the item to"),
          cardId: z.string().optional().describe("ID of the card to scope checklist search to (recommended to avoid ambiguity)"),
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
        }
      },
      async ({ text, checkListName, cardId, boardId }) => {
        try {
          const item = await this.trelloClient.addChecklistItem(text, checkListName, cardId, boardId);
          return {
            content: [{ type: "text", text: JSON.stringify(item, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "find_checklist_items_by_description",
      {
        title: "Find Checklist Items by Description",
        description: "Search for checklist items containing specific text in their description",
        inputSchema: {
          description: z.string().describe("Text to search for in checklist item descriptions"),
          cardId: z.string().optional().describe("ID of the card to scope checklist search to (recommended to avoid ambiguity)"),
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
        }
      },
      async ({ description, cardId, boardId }) => {
        try {
          const items = await this.trelloClient.findChecklistItemsByDescription(
            description,
            cardId,
            boardId
          );
          return {
            content: [{ type: "text", text: JSON.stringify(items, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_acceptance_criteria",
      {
        title: "Get Acceptance Criteria",
        description: 'Get all items from the "Acceptance Criteria" checklist',
        inputSchema: {
          cardId: z.string().optional().describe("ID of the card to scope checklist search to (recommended to avoid ambiguity)"),
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
        }
      },
      async ({ cardId, boardId }) => {
        try {
          const items = await this.trelloClient.getAcceptanceCriteria(cardId, boardId);
          return {
            content: [{ type: "text", text: JSON.stringify(items, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_checklist_by_name",
      {
        title: "Get Checklist by Name",
        description: "Get a complete checklist with all its items and completion percentage",
        inputSchema: {
          name: z.string().describe("Name of the checklist to retrieve"),
          cardId: z.string().optional().describe("ID of the card to scope checklist search to (recommended to avoid ambiguity)"),
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
        }
      },
      async ({ name, cardId, boardId }) => {
        try {
          const checklist = await this.trelloClient.getChecklistByName(name, cardId, boardId);
          if (!checklist) {
            return {
              content: [{ type: "text", text: `Checklist "${name}" not found` }],
              isError: true
            };
          }
          return {
            content: [{ type: "text", text: JSON.stringify(checklist, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "update_checklist_item",
      {
        title: "Update Checklist Item",
        description: "Update a checklist item state (mark as complete or incomplete)",
        inputSchema: {
          cardId: z.string().describe("ID of the card containing the checklist item"),
          checkItemId: z.string().describe("ID of the checklist item to update"),
          state: z.enum(["complete", "incomplete"]).describe("New state for the checklist item")
        }
      },
      async ({ cardId, checkItemId, state }) => {
        try {
          const item = await this.trelloClient.updateChecklistItem(cardId, checkItemId, state);
          return {
            content: [{ type: "text", text: JSON.stringify(item, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_board_members",
      {
        title: "Get Board Members",
        description: "Get all members of a specific board",
        inputSchema: {
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
        }
      },
      async ({ boardId }) => {
        try {
          const members = await this.trelloClient.getBoardMembers(boardId);
          return {
            content: [{ type: "text", text: JSON.stringify(members, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "assign_member_to_card",
      {
        title: "Assign Member to Card",
        description: "Assign a member to a specific card",
        inputSchema: {
          cardId: z.string().describe("ID of the card to assign the member to"),
          memberId: z.string().describe("ID of the member to assign to the card")
        }
      },
      async ({ cardId, memberId }) => {
        try {
          const card = await this.trelloClient.assignMemberToCard(cardId, memberId);
          return {
            content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "remove_member_from_card",
      {
        title: "Remove Member from Card",
        description: "Remove a member from a specific card",
        inputSchema: {
          cardId: z.string().describe("ID of the card to remove the member from"),
          memberId: z.string().describe("ID of the member to remove from the card")
        }
      },
      async ({ cardId, memberId }) => {
        try {
          const card = await this.trelloClient.removeMemberFromCard(cardId, memberId);
          return {
            content: [{ type: "text", text: JSON.stringify(card, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_board_labels",
      {
        title: "Get Board Labels",
        description: "Get all labels of a specific board",
        inputSchema: {
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)")
        }
      },
      async ({ boardId }) => {
        try {
          const labels = await this.trelloClient.getBoardLabels(boardId);
          return {
            content: [{ type: "text", text: JSON.stringify(labels, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "create_label",
      {
        title: "Create Label",
        description: "Create a new label on a board",
        inputSchema: {
          boardId: z.string().optional().describe("ID of the Trello board (uses default if not provided)"),
          name: z.string().describe("Name of the label"),
          color: z.string().optional().describe(
            'Color of the label (e.g., "red", "blue", "green", "yellow", "orange", "purple", "pink", "sky", "lime", "black", "null")'
          )
        }
      },
      async ({ boardId, name, color }) => {
        try {
          const label = await this.trelloClient.createLabel(boardId, name, color);
          return {
            content: [{ type: "text", text: JSON.stringify(label, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "update_label",
      {
        title: "Update Label",
        description: "Update an existing label",
        inputSchema: {
          labelId: z.string().describe("ID of the label to update"),
          name: z.string().optional().describe("New name for the label"),
          color: z.string().optional().describe("New color for the label")
        }
      },
      async ({ labelId, name, color }) => {
        try {
          const label = await this.trelloClient.updateLabel(labelId, name, color);
          return {
            content: [{ type: "text", text: JSON.stringify(label, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "delete_label",
      {
        title: "Delete Label",
        description: "Delete a label from a board",
        inputSchema: {
          labelId: z.string().describe("ID of the label to delete")
        }
      },
      async ({ labelId }) => {
        try {
          await this.trelloClient.deleteLabel(labelId);
          return {
            content: [{ type: "text", text: "Label deleted successfully" }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_card_history",
      {
        title: "Get Card History",
        description: "Get the history/actions of a specific card",
        inputSchema: {
          cardId: z.string().describe("ID of the card to get history for"),
          filter: z.string().optional().describe(
            'Optional: Filter actions by type (e.g., "all", "updateCard:idList", "addAttachmentToCard", "commentCard", "updateCard:name", "updateCard:desc", "updateCard:due", "addMemberToCard", "removeMemberFromCard", "addLabelToCard", "removeLabelFromCard")'
          ),
          limit: z.number().optional().describe("Optional: Number of actions to fetch (default: all)")
        }
      },
      async ({ cardId, filter, limit }) => {
        try {
          const history = await this.trelloClient.getCardHistory(cardId, filter, limit);
          return {
            content: [{ type: "text", text: JSON.stringify(history, null, 2) }]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "download_attachment",
      {
        title: "Download Attachment",
        description: "Download an attachment from a card. Returns base64-encoded data that can be saved or viewed.",
        inputSchema: {
          cardId: z.string().describe("ID of the card containing the attachment"),
          attachmentId: z.string().describe("ID of the attachment to download")
        }
      },
      async ({ cardId, attachmentId }) => {
        try {
          const result = await this.trelloClient.downloadAttachment(cardId, attachmentId);
          if (result.mimeType.startsWith("image/")) {
            return {
              content: [
                {
                  type: "image",
                  data: result.data,
                  mimeType: result.mimeType
                },
                {
                  type: "text",
                  text: `Downloaded: ${result.fileName} (${result.mimeType})`
                }
              ]
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  fileName: result.fileName,
                  mimeType: result.mimeType,
                  data: result.data
                }, null, 2)
              }
            ]
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
  }
  setupHealthEndpoints() {
    this.server.registerTool("get_health", HealthEndpointSchemas.basicHealth, async () => {
      try {
        return await this.healthEndpoints.getBasicHealth();
      } catch (error) {
        return this.handleError(error);
      }
    });
    this.server.registerTool(
      "get_health_detailed",
      HealthEndpointSchemas.detailedHealth,
      async () => {
        try {
          return await this.healthEndpoints.getDetailedHealth();
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_health_metadata",
      HealthEndpointSchemas.metadataHealth,
      async () => {
        try {
          return await this.healthEndpoints.getMetadataHealth();
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool(
      "get_health_performance",
      HealthEndpointSchemas.performanceHealth,
      async () => {
        try {
          return await this.healthEndpoints.getPerformanceHealth();
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
    this.server.registerTool("perform_system_repair", HealthEndpointSchemas.repair, async () => {
      try {
        return await this.healthEndpoints.performRepair();
      } catch (error) {
        return this.handleError(error);
      }
    });
  }
  async run() {
    const transport = new StdioServerTransport();
    await this.trelloClient.loadConfig().catch(() => {
    });
    await this.server.connect(transport);
  }
};
var server = new TrelloServer();
server.run().catch(() => {
});
