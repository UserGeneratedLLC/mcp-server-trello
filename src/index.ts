#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TrelloClient } from './trello-client.js';
import { TrelloHealthEndpoints, HealthEndpointSchemas } from './health/health-endpoints.js';
import { formatCardListResponse } from './card-list-preview.js';

class TrelloServer {
  private server: McpServer;
  private trelloClient: TrelloClient;
  private healthEndpoints: TrelloHealthEndpoints;

  constructor() {
    const apiKey = process.env.TRELLO_API_KEY;
    const token = process.env.TRELLO_TOKEN;
    const defaultBoardId = process.env.TRELLO_BOARD_ID;
    const allowedWorkspacesEnv = process.env.TRELLO_ALLOWED_WORKSPACES;

    if (!apiKey || !token) {
      throw new Error('TRELLO_API_KEY and TRELLO_TOKEN environment variables are required');
    }

    // Parse allowed workspaces from comma-separated string
    const allowedWorkspaceIds = allowedWorkspacesEnv
      ? allowedWorkspacesEnv.split(',').map(id => id.trim()).filter(id => id.length > 0)
      : undefined;

    this.trelloClient = new TrelloClient({
      apiKey,
      token,
      defaultBoardId,
      boardId: defaultBoardId,
      allowedWorkspaceIds,
    });

    this.healthEndpoints = new TrelloHealthEndpoints(this.trelloClient);

    this.server = new McpServer({
      name: 'trello-server',
      version: '1.8.0',
    });

    this.setupTools();
    this.setupSearchTools();
    this.setupHealthEndpoints();

    // Error handling
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private handleError(error: unknown) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        },
      ],
      isError: true,
    };
  }

  // Compact summary instead of the full Trello attachment JSON, which carries
  // a ~10-entry previews array of URLs that just bloats agent context
  private attachmentSummary(attachment: {
    id: string;
    name: string;
    url: string;
    bytes: number | null;
    mimeType: string;
  }) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              id: attachment.id,
              name: attachment.name,
              url: attachment.url,
              bytes: attachment.bytes,
              mimeType: attachment.mimeType,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private setupTools() {
    // Get cards from a specific list
    this.server.registerTool(
      'get_cards_by_list_id',
      {
        title: 'Get Cards by List ID',
        description:
          'Fetch cards from a specific Trello list on a specific board. Descriptions are previewed by default to keep responses compact; set fields without "desc" to omit descriptions, or increase descMaxLength/omitDescThresholdBytes and use get_card for full details.',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          listId: z.string().describe('ID of the Trello list'),
          fields: z
            .string()
            .optional()
            .describe('Comma-separated list of fields to return (e.g., "name,idShort,labels,due,dueComplete"). Omit for all fields.'),
          nameFilter: z
            .string()
            .trim()
            .min(1, 'nameFilter must not be empty')
            .optional()
            .describe('Optional substring to filter cards by name (case-insensitive)'),
          descMaxLength: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              'Maximum description preview length per card. Defaults to 200. Increase for fuller descriptions.'
            ),
          omitDescThresholdBytes: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Approximate response size threshold before descriptions are omitted. Defaults to 50000 bytes.'
            ),
        },
      },
      async ({ listId, fields, nameFilter, descMaxLength, omitDescThresholdBytes }) => {
        try {
          const cards = await this.trelloClient.getCardsByList(listId, fields, nameFilter);
          return formatCardListResponse(cards, { descMaxLength, omitDescThresholdBytes });
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get all lists from a board
    this.server.registerTool(
      'get_lists',
      {
        title: 'Get Lists',
        description: 'Retrieve all lists from the specified board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ boardId }) => {
        try {
          const lists = await this.trelloClient.getLists(boardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(lists, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get recent activity
    this.server.registerTool(
      'get_recent_activity',
      {
        title: 'Get Recent Activity',
        description: 'Fetch recent activity on the Trello board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          limit: z
            .number()
            .optional()
            .default(10)
            .describe('Number of activities to fetch (default: 10)'),
          since: z
            .string()
            .optional()
            .describe('Only return actions after this date (ISO 8601) or action ID'),
          before: z
            .string()
            .optional()
            .describe('Only return actions before this date (ISO 8601) or action ID'),
        },
      },
      async ({ boardId, limit, since, before }) => {
        try {
          const activity = await this.trelloClient.getRecentActivity(boardId, limit, since, before);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(activity, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Add a new card to a list
    this.server.registerTool(
      'add_card_to_list',
      {
        title: 'Add Card to List',
        description: 'Add a new card to a specified list on a specific board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          listId: z.string().describe('ID of the list to add the card to'),
          name: z.string().describe('Name of the card'),
          description: z.string().optional().describe('Description of the card'),
          dueDate: z.string().optional().describe('Due date for the card (ISO 8601 format)'),
          dueReminder: z
            .number()
            .int()
            .nullable()
            .optional()
            .describe(
              'Due date reminder in minutes before due date (e.g., null to remove reminder, 0 at due time, 1440 one day before)'
            ),
          start: z
            .string()
            .optional()
            .describe('Start date for the card (YYYY-MM-DD format, date only)'),
          labels: z
            .array(z.string())
            .optional()
            .describe('Array of label IDs to apply to the card'),
        },
      },
      async args => {
        try {
          const card = await this.trelloClient.addCard(args.boardId, args);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Update card details
    this.server.registerTool(
      'update_card_details',
      {
        title: 'Update Card Details',
        description: "Update an existing card's details on a specific board",
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          cardId: z.string().describe('ID of the card to update'),
          name: z.string().optional().describe('New name for the card'),
          description: z.string().optional().describe('New description for the card'),
          dueDate: z.string().optional().describe('New due date for the card (ISO 8601 format)'),
          dueReminder: z
            .number()
            .int()
            .nullable()
            .optional()
            .describe(
              'New due date reminder in minutes before due date (e.g., null to remove reminder, 0 at due time, 1440 one day before)'
            ),
          start: z
            .string()
            .optional()
            .describe('New start date for the card (YYYY-MM-DD format, date only)'),
          dueComplete: z
            .boolean()
            .optional()
            .describe('Mark the due date as complete (true) or incomplete (false)'),
          labels: z.array(z.string()).optional().describe('New array of label IDs for the card'),
          pos: z
            .union([z.string(), z.number()])
            .optional()
            .describe(
              'Position of the card in the list. Accepts "top", "bottom", or a positive number'
            ),
        },
      },
      async args => {
        try {
          const card = await this.trelloClient.updateCard(args.boardId, args);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Archive a card
    this.server.registerTool(
      'archive_card',
      {
        title: 'Archive Card',
        description: 'Send a card to the archive on a specific board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          cardId: z.string().describe('ID of the card to archive'),
        },
      },
      async ({ boardId, cardId }) => {
        try {
          const card = await this.trelloClient.archiveCard(boardId, cardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // ─── Watch Card (subscribe/unsubscribe) ──
    this.server.registerTool(
      'watch_card',
      {
        title: 'Watch Card',
        description: 'Subscribe or unsubscribe from watching a card for activity notifications',
        inputSchema: {
          cardId: z.string().describe('ID of the card to watch/unwatch'),
          subscribed: z.boolean().describe('Set to true to start watching, false to stop'),
        },
      },
      async ({ cardId, subscribed }) => {
        try {
          const card = await this.trelloClient.watchCard(cardId, subscribed);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // ─── Watch List (subscribe/unsubscribe) ──
    this.server.registerTool(
      'watch_list',
      {
        title: 'Watch List',
        description: 'Subscribe or unsubscribe from watching a list for activity notifications',
        inputSchema: {
          listId: z.string().describe('ID of the list to watch/unwatch'),
          subscribed: z.boolean().describe('Set to true to start watching, false to stop'),
        },
      },
      async ({ listId, subscribed }) => {
        try {
          const list = await this.trelloClient.watchList(listId, subscribed);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Move a card
    this.server.registerTool(
      'move_card',
      {
        title: 'Move Card',
        description: 'Move a card to a different list, potentially on a different board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe(
              'ID of the target Trello board (where the listId resides, uses default if not provided)'
            ),
          cardId: z.string().describe('ID of the card to move'),
          listId: z.string().describe('ID of the target list'),
          pos: z
            .union([z.string(), z.number()])
            .optional()
            .describe(
              'Position of the card in the target list. Accepts "top", "bottom", or a positive number'
            ),
        },
      },
      async ({ boardId, cardId, listId, pos }) => {
        try {
          const card = await this.trelloClient.moveCard(boardId, cardId, listId, pos);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Add a new list to a board
    this.server.registerTool(
      'add_list_to_board',
      {
        title: 'Add List to Board',
        description: 'Add a new list to the specified board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          name: z.string().describe('Name of the new list'),
        },
      },
      async ({ boardId, name }) => {
        try {
          const list = await this.trelloClient.addList(boardId, name);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Archive a list
    this.server.registerTool(
      'archive_list',
      {
        title: 'Archive List',
        description: 'Send a list to the archive on a specific board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          listId: z.string().describe('ID of the list to archive'),
        },
      },
      async ({ boardId, listId }) => {
        try {
          const list = await this.trelloClient.archiveList(boardId, listId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Update a list
    this.server.registerTool(
      'update_list',
      {
        title: 'Update List',
        description:
          'Update a list name, archive state, subscription state, or board. Use update_list_position for moving a list within a board.',
        inputSchema: {
          listId: z.string().describe('ID of the Trello list to update'),
          name: z.string().optional().describe('New name for the list'),
          closed: z.boolean().optional().describe('Whether to close (archive) the list'),
          subscribed: z
            .boolean()
            .optional()
            .describe('Whether the authenticated user is subscribed to the list'),
          idBoard: z.string().optional().describe('ID of a board to move the list to'),
        },
      },
      async ({ listId, name, closed, subscribed, idBoard }) => {
        try {
          const params: {
            name?: string;
            closed?: boolean;
            subscribed?: boolean;
            idBoard?: string;
          } = {};
          if (name !== undefined) params.name = name;
          if (closed !== undefined) params.closed = closed;
          if (subscribed !== undefined) params.subscribed = subscribed;
          if (idBoard !== undefined) params.idBoard = idBoard;
          if (Object.keys(params).length === 0) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'At least one of name, closed, subscribed, or idBoard must be provided'
            );
          }
          const list = await this.trelloClient.updateList(listId, params);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Update list position
    this.server.registerTool(
      'update_list_position',
      {
        title: 'Update List Position',
        description:
          'Update the position of a list on the board. Trello uses fractional indexing: each list has a float position, and to place a list between two others, use the average of their positions (e.g., between pos 1024 and 2048, use 1536). Use "top"/"bottom" shortcuts to move to the edges.',
        inputSchema: {
          listId: z.string().describe('ID of the list to reposition'),
          position: z
            .string()
            .refine(
              (val) => {
                if (val === 'top' || val === 'bottom') return true;
                const num = Number(val);
                return num > 0 && isFinite(num);
              },
              {
                message: "Position must be 'top', 'bottom', or a positive finite numeric string.",
              }
            )
            .describe(
              'New position: "top" (move to leftmost), "bottom" (move to rightmost), or a numeric string (e.g. "1536"). To place between two lists, use the average of their pos values.'
            ),
        },
      },
      async ({ listId, position }) => {
        try {
          const parsedPosition =
            position === 'top' || position === 'bottom' ? position : Number(position);
          const list = await this.trelloClient.updateListPosition(listId, parsedPosition);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get cards assigned to current user
    this.server.registerTool(
      'get_my_cards',
      {
        title: 'Get My Cards',
        description: 'Fetch all cards assigned to the current user',
        inputSchema: {},
      },
      async () => {
        try {
          const cards = await this.trelloClient.getMyCards();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(cards, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Attach image to card (local path or URL)
    this.server.registerTool(
      'attach_image_to_card',
      {
        title: 'Attach Image to Card',
        description:
          'Attach an image to a card. For images on disk, pass the absolute file path via filePath (or imageUrl) — the file is streamed directly, no base64 conversion, works for images of any size. For web images, pass an https URL and Trello fetches it server-side.',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe(
              'ID of the Trello board where the card exists (uses default if not provided)'
            ),
          cardId: z.string().describe('ID of the card to attach the image to'),
          imageUrl: z
            .string()
            .optional()
            .describe(
              'Local file path (absolute, ~/path, or file://) or https URL of the image. Provide either this or filePath.'
            ),
          filePath: z
            .string()
            .optional()
            .describe(
              'Absolute path to a local image file (e.g. /Users/me/screenshot.png). Preferred for files on disk. Provide either this or imageUrl.'
            ),
          name: z
            .string()
            .optional()
            .describe('Optional name for the attachment (defaults to the image filename)'),
        },
      },
      async ({ boardId, cardId, imageUrl, filePath, name }) => {
        try {
          const source = filePath ?? imageUrl;
          if (!source || (filePath && imageUrl)) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              'Provide exactly one of filePath (local file) or imageUrl (local path or https URL)'
            );
          }
          const attachment = await this.trelloClient.attachImageToCard(
            boardId,
            cardId,
            source,
            name
          );
          return this.attachmentSummary(attachment);
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Attach file to card (local path or URL)
    this.server.registerTool(
      'attach_file_to_card',
      {
        title: 'Attach File to Card',
        description:
          'Attach any file to a card. For files on disk, pass the absolute file path via filePath (or fileUrl) — the file is streamed directly, no base64 conversion, works for files of any size. For web files, pass an https URL and Trello fetches it server-side.',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe(
              'ID of the Trello board where the card exists (uses default if not provided)'
            ),
          cardId: z.string().describe('ID of the card to attach the file to'),
          fileUrl: z
            .string()
            .optional()
            .describe(
              'Local file path (absolute, ~/path, or file://) or https URL of the file. Provide either this or filePath.'
            ),
          filePath: z
            .string()
            .optional()
            .describe(
              'Absolute path to a local file (e.g. /Users/me/report.pdf). Preferred for files on disk. Provide either this or fileUrl.'
            ),
          name: z
            .string()
            .optional()
            .describe('Optional name for the attachment (defaults to the filename)'),
          mimeType: z
            .string()
            .optional()
            .describe(
              'Optional MIME type of the file (e.g., "application/pdf", "text/plain", "video/mp4"). Inferred from the file extension if omitted.'
            ),
        },
      },
      async ({ boardId, cardId, fileUrl, filePath, name, mimeType }) => {
        try {
          const source = filePath ?? fileUrl;
          if (!source || (filePath && fileUrl)) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              'Provide exactly one of filePath (local file) or fileUrl (local path or https URL)'
            );
          }
          const attachment = await this.trelloClient.attachFileToCard(
            boardId,
            cardId,
            source,
            name,
            mimeType
          );
          return this.attachmentSummary(attachment);
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Attach arbitrary binary data to a card (base64 or data URL)
    this.server.registerTool(
      'attach_data_to_card',
      {
        title: 'Attach Data to Card',
        description:
          'Attach in-memory data to a card as a file, from base64 or a data URL. Only for content you generated in memory — if the content exists on disk, use attach_file_to_card with its path instead: no base64 conversion, no size limits.',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe(
              'ID of the Trello board where the card exists (uses default if not provided)'
            ),
          cardId: z.string().describe('ID of the card to attach the data to'),
          data: z
            .string()
            .describe(
              'Base64-encoded data or a data URL (e.g. data:text/markdown;base64,...). Do NOT pass file paths here — use attach_file_to_card for files on disk.'
            ),
          name: z
            .string()
            .optional()
            .describe(
              'Filename for the attachment, including extension (e.g. "notes.md", "report.pdf"). Defaults to "attachment-<timestamp>".'
            ),
          mimeType: z
            .string()
            .optional()
            .describe(
              'MIME type of the data (e.g. "text/markdown", "application/pdf", "image/png"). Recommended for correct rendering in Trello. If omitted, inferred from a data URL prefix or the filename extension; falls back to "application/octet-stream".'
            ),
        },
      },
      async ({ boardId, cardId, data, name, mimeType }) => {
        try {
          const attachment = await this.trelloClient.attachDataToCard(
            boardId,
            cardId,
            data,
            name,
            mimeType
          );
          return this.attachmentSummary(attachment);
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Attach image data to card (image-flavored convenience over attach_data_to_card)
    this.server.registerTool(
      'attach_image_data_to_card',
      {
        title: 'Attach Image Data to Card',
        description:
          'Attach an in-memory image to a card from base64 or a data URL (PNG defaults). Only for image bytes you already hold in memory — if the image exists on disk (screenshot files, renders), use attach_file_to_card with its path instead: no base64 conversion, no size limits.',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe(
              'ID of the Trello board where the card exists (uses default if not provided)'
            ),
          cardId: z.string().describe('ID of the card to attach the image to'),
          imageData: z
            .string()
            .describe(
              'Base64 encoded image data or data URL (e.g., data:image/png;base64,...). Do NOT pass file paths here — use attach_file_to_card for images on disk.'
            ),
          name: z
            .string()
            .optional()
            .describe('Optional name for the attachment'),
          mimeType: z
            .string()
            .optional()
            .default('image/png')
            .describe('Optional MIME type (default: image/png)'),
        },
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
          return this.attachmentSummary(attachment);
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // ─── Get Card Attachments ──
    this.server.registerTool(
      'get_card_attachments',
      {
        title: 'Get Card Attachments',
        description: 'Get all attachments from a specific card',
        inputSchema: {
          cardId: z.string().describe('ID of the card'),
        },
      },
      async ({ cardId }) => {
        try {
          const attachments = await this.trelloClient.getCardAttachments(cardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ attachments }, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // ─── Get Card Checklists ──
    this.server.registerTool(
      'get_card_checklists',
      {
        title: 'Get Card Checklists',
        description: 'Get all checklists on a card with their items and completion percentage',
        inputSchema: {
          cardId: z.string().describe('ID of the card'),
        },
      },
      async ({ cardId }) => {
        try {
          const checklists = await this.trelloClient.getCardChecklists(cardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ checklists }, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // List all boards
    this.server.registerTool(
      'list_boards',
      {
        title: 'List Boards',
        description: 'List all boards the user has access to',
        inputSchema: {},
      },
      async () => {
        try {
          const boards = await this.trelloClient.listBoards();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(boards, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Set active board
    this.server.registerTool(
      'set_active_board',
      {
        title: 'Set Active Board',
        description: 'Set the active board for future operations',
        inputSchema: {
          boardId: z.string().describe('ID of the board to set as active'),
        },
      },
      async ({ boardId }) => {
        try {
          const board = await this.trelloClient.setActiveBoard(boardId);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Successfully set active board to "${board.name}" (${board.id})`,
              },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // List workspaces
    this.server.registerTool(
      'list_workspaces',
      {
        title: 'List Workspaces',
        description:
          'List workspaces the user has access to. If TRELLO_ALLOWED_WORKSPACES is configured, only allowed workspaces are returned.',
        inputSchema: {},
      },
      async () => {
        try {
          const workspaces = await this.trelloClient.listWorkspaces();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(workspaces, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Create a new board
    this.server.registerTool(
      'create_board',
      {
        title: 'Create Board',
        description: 'Create a new Trello board optionally within a workspace',
        inputSchema: {
          name: z.string().describe('Name of the board'),
          desc: z.string().optional().describe('Description of the board'),
          idOrganization: z
            .string()
            .min(1)
            .optional()
            .describe('Workspace ID to create the board in (uses active if not provided)'),
          defaultLabels: z
            .boolean()
            .optional()
            .default(true)
            .describe('Create default labels (true by default)'),
          defaultLists: z
            .boolean()
            .optional()
            .default(true)
            .describe('Create default lists (true by default)'),
        },
      },
      async ({ name, desc, idOrganization, defaultLabels, defaultLists }) => {
        try {
          const board = await this.trelloClient.createBoard({
            name,
            desc,
            idOrganization,
            defaultLabels,
            defaultLists,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(board, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Set active workspace
    this.server.registerTool(
      'set_active_workspace',
      {
        title: 'Set Active Workspace',
        description: 'Set the active workspace for future operations',
        inputSchema: {
          workspaceId: z.string().describe('ID of the workspace to set as active'),
        },
      },
      async ({ workspaceId }) => {
        try {
          const workspace = await this.trelloClient.setActiveWorkspace(workspaceId);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Successfully set active workspace to "${workspace.displayName}" (${workspace.id})`,
              },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // List boards in workspace
    this.server.registerTool(
      'list_boards_in_workspace',
      {
        title: 'List Boards in Workspace',
        description: 'List all boards in a specific workspace',
        inputSchema: {
          workspaceId: z.string().describe('ID of the workspace to list boards from'),
        },
      },
      async ({ workspaceId }) => {
        try {
          const boards = await this.trelloClient.listBoardsInWorkspace(workspaceId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(boards, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get active board info
    this.server.registerTool(
      'get_active_board_info',
      {
        title: 'Get Active Board Info',
        description: 'Get information about the currently active board',
        inputSchema: {},
      },
      async () => {
        try {
          const boardId = this.trelloClient.activeBoardId;
          if (!boardId) {
            return {
              content: [{ type: 'text' as const, text: 'No active board set' }],
              isError: true,
            };
          }
          const board = await this.trelloClient.getBoardById(boardId);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    ...board,
                    isActive: true,
                    activeWorkspaceId: this.trelloClient.activeWorkspaceId || 'Not set',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get card details
    this.server.registerTool(
      'get_card',
      {
        title: 'Get Card',
        description: 'Get detailed information about a specific Trello card',
        inputSchema: {
          cardId: z.string().describe('ID of the card to fetch'),
          includeMarkdown: z
            .boolean()
            .optional()
            .default(false)
            .describe('Whether to return card description in markdown format (default: false)'),
        },
      },
      async ({ cardId, includeMarkdown }) => {
        try {
          const card = await this.trelloClient.getCard(cardId, includeMarkdown);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Add a comment to a card
    this.server.registerTool(
      'add_comment',
      {
        title: 'Add Comment to Card',
        description: 'Add the given text as a new comment to the given card',
        inputSchema: {
          cardId: z.string().describe('ID of the card to comment on'),
          text: z.string().describe('The text of the comment to add'),
        },
      },
      async ({ cardId, text }) => {
        try {
          const comment = await this.trelloClient.addCommentToCard(cardId, text);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(comment, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Update a comment to a card
    this.server.registerTool(
      'update_comment',
      {
        title: 'Update Comment on Card',
        description: 'Update the given comment with the new text',
        inputSchema: {
          commentId: z.string().describe('ID of the comment to change'),
          text: z.string().describe('The new text of the comment'),
        },
      },
      async ({ commentId, text }) => {
        try {
          const success = await this.trelloClient.updateCommentOnCard(commentId, text);
          return {
            content: [{ type: 'text' as const, text: success ? 'success' : 'failure' }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Delete a comment from a card
    this.server.registerTool(
      'delete_comment',
      {
        title: 'Delete Comment from Card',
        description: 'Delete a comment from a Trello card',
        inputSchema: {
          commentId: z.string().describe('ID of the comment to delete'),
        },
      },
      async ({ commentId }) => {
        try {
          const success = await this.trelloClient.deleteCommentFromCard(commentId);
          return {
            content: [{ type: 'text' as const, text: success ? 'success' : 'failure' }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Get comments from a card
    this.server.registerTool(
      'get_card_comments',
      {
        title: 'Get Card Comments',
        description: 'Retrieve all comments from a specific Trello card',
        inputSchema: {
          cardId: z.string().describe('ID of the card to get comments from'),
          limit: z
            .number()
            .optional()
            .default(100)
            .describe('Maximum number of comments to retrieve (default: 100)'),
        },
      },
      async ({ cardId, limit }) => {
        try {
          const comments = await this.trelloClient.getCardComments(cardId, limit);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(comments, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Checklist tools
    this.server.registerTool(
      'create_checklist',
      {
        title: 'Create Checklist',
        description: 'Create a new checklist',
        inputSchema: {
          name: z.string().describe('Name of the checklist to create'),
          cardId: z.string().describe('ID of the Trello card'),
        },
      },
      async ({ name, cardId }) => {
        try {
          const items = await this.trelloClient.createChecklist(name, cardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Checklist tools
    this.server.registerTool(
      'get_checklist_items',
      {
        title: 'Get Checklist Items',
        description: 'Get all items from a checklist by name',
        inputSchema: {
          name: z.string().describe('Name of the checklist to retrieve items from'),
          cardId: z
            .string()
            .optional()
            .describe('ID of the card to scope checklist search to (recommended to avoid ambiguity)'),
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ name, cardId, boardId }) => {
        try {
          const items = await this.trelloClient.getChecklistItems(name, cardId, boardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'add_checklist_item',
      {
        title: 'Add Checklist Item',
        description: 'Add a new item to a checklist',
        inputSchema: {
          text: z.string().describe('Text content of the checklist item'),
          checkListName: z.string().describe('Name of the checklist to add the item to'),
          cardId: z
            .string()
            .optional()
            .describe('ID of the card to scope checklist search to (recommended to avoid ambiguity)'),
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ text, checkListName, cardId, boardId }) => {
        try {
          const item = await this.trelloClient.addChecklistItem(text, checkListName, cardId, boardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'find_checklist_items_by_description',
      {
        title: 'Find Checklist Items by Description',
        description: 'Search for checklist items containing specific text in their description',
        inputSchema: {
          description: z.string().describe('Text to search for in checklist item descriptions'),
          cardId: z
            .string()
            .optional()
            .describe('ID of the card to scope checklist search to (recommended to avoid ambiguity)'),
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ description, cardId, boardId }) => {
        try {
          const items = await this.trelloClient.findChecklistItemsByDescription(
            description,
            cardId,
            boardId
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'get_acceptance_criteria',
      {
        title: 'Get Acceptance Criteria',
        description: 'Get all items from the "Acceptance Criteria" checklist',
        inputSchema: {
          cardId: z
            .string()
            .optional()
            .describe('ID of the card to scope checklist search to (recommended to avoid ambiguity)'),
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ cardId, boardId }) => {
        try {
          const items = await this.trelloClient.getAcceptanceCriteria(cardId, boardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'get_checklist_by_name',
      {
        title: 'Get Checklist by Name',
        description: 'Get a complete checklist with all its items and completion percentage',
        inputSchema: {
          name: z.string().describe('Name of the checklist to retrieve'),
          cardId: z
            .string()
            .optional()
            .describe('ID of the card to scope checklist search to (recommended to avoid ambiguity)'),
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ name, cardId, boardId }) => {
        try {
          const checklist = await this.trelloClient.getChecklistByName(name, cardId, boardId);
          if (!checklist) {
            return {
              content: [{ type: 'text' as const, text: `Checklist "${name}" not found` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(checklist, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'update_checklist_item',
      {
        title: 'Update Checklist Item',
        description: 'Update a checklist item name, state, position, due date, reminder, or assigned member',
        inputSchema: {
          cardId: z.string().describe('ID of the card containing the checklist item'),
          checkItemId: z.string().describe('ID of the checklist item to update'),
          state: z
            .enum(['complete', 'incomplete'])
            .optional()
            .describe('New state for the checklist item'),
          name: z.string().optional().describe('New text for the checklist item'),
          pos: z
            .union([z.number(), z.enum(['top', 'bottom'])])
            .optional()
            .describe('New position for the checklist item'),
          due: z
            .string()
            .nullable()
            .optional()
            .describe('New due date for the checklist item in ISO 8601 format, or null to clear it'),
          dueReminder: z
            .number()
            .nullable()
            .optional()
            .describe('Reminder offset in minutes before due date, or null to clear it'),
          idMember: z
            .string()
            .nullable()
            .optional()
            .describe('Member ID to assign to the checklist item, or null to clear it'),
        },
      },
      async ({ cardId, checkItemId, name, state, pos, due, dueReminder, idMember }) => {
        try {
          const item = await this.trelloClient.updateChecklistItem(cardId, checkItemId, {
            name,
            state,
            pos,
            due,
            dueReminder,
            idMember,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(item, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'delete_checklist',
      {
        title: 'Delete Checklist',
        description: 'Delete a checklist from a card',
        inputSchema: {
          checklistId: z.string().describe('ID of the checklist to delete'),
        },
      },
      async ({ checklistId }) => {
        try {
          await this.trelloClient.deleteChecklist(checklistId);
          return {
            content: [{ type: 'text' as const, text: 'Checklist deleted successfully' }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'delete_checklist_item',
      {
        title: 'Delete Checklist Item',
        description: 'Delete an item from a checklist (by checklist ID)',
        inputSchema: {
          checklistId: z.string().describe('ID of the checklist containing the item'),
          checkItemId: z.string().describe('ID of the checklist item to delete'),
        },
      },
      async ({ checklistId, checkItemId }) => {
        try {
          await this.trelloClient.deleteChecklistItem(checklistId, checkItemId);
          return {
            content: [{ type: 'text' as const, text: 'Checklist item deleted successfully' }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'delete_checklist_item_by_card',
      {
        title: 'Delete Checklist Item By Card',
        description: 'Delete a checklist item from a card (uses the card-scoped Trello endpoint)',
        inputSchema: {
          cardId: z.string().describe('ID of the card containing the checklist item'),
          checkItemId: z.string().describe('ID of the checklist item to delete'),
        },
      },
      async ({ cardId, checkItemId }) => {
        try {
          const deleted = await this.trelloClient.deleteChecklistItemByCard(cardId, checkItemId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ deleted }, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Member management tools
    this.server.registerTool(
      'get_board_members',
      {
        title: 'Get Board Members',
        description: 'Get all members of a specific board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ boardId }) => {
        try {
          const members = await this.trelloClient.getBoardMembers(boardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(members, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'assign_member_to_card',
      {
        title: 'Assign Member to Card',
        description: 'Assign a member to a specific card',
        inputSchema: {
          cardId: z.string().describe('ID of the card to assign the member to'),
          memberId: z.string().describe('ID of the member to assign to the card'),
        },
      },
      async ({ cardId, memberId }) => {
        try {
          const card = await this.trelloClient.assignMemberToCard(cardId, memberId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'remove_member_from_card',
      {
        title: 'Remove Member from Card',
        description: 'Remove a member from a specific card',
        inputSchema: {
          cardId: z.string().describe('ID of the card to remove the member from'),
          memberId: z.string().describe('ID of the member to remove from the card'),
        },
      },
      async ({ cardId, memberId }) => {
        try {
          const card = await this.trelloClient.removeMemberFromCard(cardId, memberId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Label management tools
    this.server.registerTool(
      'get_board_labels',
      {
        title: 'Get Board Labels',
        description: 'Get all labels of a specific board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ boardId }) => {
        try {
          const labels = await this.trelloClient.getBoardLabels(boardId);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(labels, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'create_label',
      {
        title: 'Create Label',
        description: 'Create a new label on a board',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          name: z.string().describe('Name of the label'),
          color: z
            .string()
            .optional()
            .describe(
              'Color of the label (e.g., "red", "blue", "green", "yellow", "orange", "purple", "pink", "sky", "lime", "black", "null")'
            ),
        },
      },
      async ({ boardId, name, color }) => {
        try {
          const label = await this.trelloClient.createLabel(boardId, name, color);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(label, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'update_label',
      {
        title: 'Update Label',
        description: 'Update an existing label',
        inputSchema: {
          labelId: z.string().describe('ID of the label to update'),
          name: z.string().optional().describe('New name for the label'),
          color: z.string().optional().describe('New color for the label'),
        },
      },
      async ({ labelId, name, color }) => {
        try {
          const label = await this.trelloClient.updateLabel(labelId, name, color);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(label, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'delete_label',
      {
        title: 'Delete Label',
        description: 'Delete a label from a board',
        inputSchema: {
          labelId: z.string().describe('ID of the label to delete'),
        },
      },
      async ({ labelId }) => {
        try {
          await this.trelloClient.deleteLabel(labelId);
          return {
            content: [{ type: 'text' as const, text: 'Label deleted successfully' }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // ─── Search Labels ──
    this.server.registerTool(
      'search_labels',
      {
        title: 'Search Labels',
        description: 'Search labels on a board by name or color',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
          query: z.string().describe('Search query to filter labels by name or color'),
        },
      },
      async ({ boardId, query }) => {
        try {
          const labels = await this.trelloClient.searchLabels(boardId, query);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ labels }, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // ─── Remove Label from Card ──
    this.server.registerTool(
      'remove_label_from_card',
      {
        title: 'Remove Label from Card',
        description: 'Remove a label from a specific card',
        inputSchema: {
          cardId: z.string().describe('ID of the card'),
          labelId: z.string().describe('ID of the label to remove'),
        },
      },
      async ({ cardId, labelId }) => {
        try {
          const success = await this.trelloClient.removeLabelFromCard(cardId, labelId);
          return {
            content: [
              {
                type: 'text' as const,
                text: success ? 'Label removed successfully' : 'Failed to remove label',
              },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Copy a card (supports cross-board copy)
    this.server.registerTool(
      'copy_card',
      {
        title: 'Copy Card',
        description:
          'Copy/duplicate a Trello card to any list (even on a different board). Copies all properties by default including checklists, attachments, comments, labels, etc.',
        inputSchema: {
          sourceCardId: z.string().describe('ID of the source card to copy'),
          listId: z
            .string()
            .describe('ID of the destination list (can be on a different board)'),
          name: z
            .string()
            .optional()
            .describe('Override the name of the copied card (defaults to source card name)'),
          description: z
            .string()
            .optional()
            .describe('Override the description of the copied card'),
          keepFromSource: z
            .string()
            .optional()
            .describe(
              'Comma-separated list of properties to copy: "all" (default), or any combination of: attachments, checklists, comments, customFields, due, start, labels, members, stickers'
            ),
          pos: z
            .string()
            .optional()
            .describe('Position of the new card: "top", "bottom", or a positive float'),
        },
      },
      async ({ sourceCardId, listId, name, description, keepFromSource, pos }) => {
        try {
          const card = await this.trelloClient.copyCard({
            sourceCardId,
            listId,
            name,
            description,
            keepFromSource,
            pos,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Copy a checklist from one card to another
    this.server.registerTool(
      'copy_checklist',
      {
        title: 'Copy Checklist',
        description:
          'Copy a checklist (with all its items) from one card to another. Works across different boards.',
        inputSchema: {
          sourceChecklistId: z
            .string()
            .describe('ID of the source checklist to copy'),
          cardId: z
            .string()
            .describe('ID of the destination card to copy the checklist to'),
          name: z
            .string()
            .optional()
            .describe('Override the name of the copied checklist (defaults to source checklist name)'),
          pos: z
            .string()
            .optional()
            .describe('Position of the new checklist: "top", "bottom", or a positive number'),
        },
      },
      async ({ sourceChecklistId, cardId, name, pos }) => {
        try {
          const checklist = await this.trelloClient.copyChecklist({
            sourceChecklistId,
            cardId,
            name,
            pos,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(checklist, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Add multiple cards to a list
    this.server.registerTool(
      'add_cards_to_list',
      {
        title: 'Add Cards to List',
        description:
          'Add multiple cards to a list in one operation. Cards are created sequentially (Trello API does not support batch writes). Rate limiting is handled automatically.',
        inputSchema: {
          listId: z.string().describe('ID of the list to add cards to'),
          cards: z
            .array(
              z.object({
                name: z.string().describe('Name of the card'),
                description: z.string().optional().describe('Description of the card'),
                dueDate: z
                  .string()
                  .optional()
                  .describe('Due date for the card (ISO 8601 format)'),
                start: z
                  .string()
                  .optional()
                  .describe('Start date for the card (YYYY-MM-DD format)'),
                labels: z
                  .array(z.string())
                  .optional()
                  .describe('Array of label IDs to apply to the card'),
              })
            )
            .describe('Array of cards to create (max 50)'),
        },
      },
      async ({ listId, cards }) => {
        try {
          const results = await this.trelloClient.batchAddCards(listId, cards);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(results, null, 2),
              },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Custom field management tools
    this.server.registerTool(
      'get_board_custom_fields',
      {
        title: 'Get Board Custom Fields',
        description:
          'Get all custom field definitions on a board. Returns field IDs, names, and types. ' +
          'For dropdown/list fields, also returns available options with their IDs. ' +
          'Requires Trello Standard plan or higher.',
        inputSchema: {
          boardId: z
            .string()
            .optional()
            .describe('ID of the Trello board (uses default if not provided)'),
        },
      },
      async ({ boardId }) => {
        try {
          const fields = await this.trelloClient.getBoardCustomFields(boardId);

          const fieldsWithOptions = await Promise.all(
            fields.map(async (field) => {
              if (field.type !== 'list') {
                return field;
              }

              try {
                const options = await this.trelloClient.getCustomFieldOptions(field.id);
                return { ...field, options };
              } catch (error) {
                return {
                  ...field,
                  optionsError: error instanceof Error ? error.message : 'Failed to fetch options',
                };
              }
            })
          );

          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(fieldsWithOptions, null, 2) },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    this.server.registerTool(
      'update_card_custom_field',
      {
        title: 'Update Card Custom Field',
        description:
          'Set or clear a custom field value on a card. Requires Trello Standard plan or higher. ' +
          'Use get_board_custom_fields first to find field IDs and types. ' +
          'Value format depends on type: text=any string, number=numeric string, ' +
          'checkbox="true"/"false", date=ISO 8601 string, list=option ID from get_board_custom_fields. ' +
          'To clear a field, set type to "clear" and omit value.',
        inputSchema: {
          cardId: z.string().describe('ID of the card to update'),
          customFieldId: z.string().describe('ID of the custom field definition'),
          type: z
            .enum(['text', 'number', 'checkbox', 'date', 'list', 'clear'])
            .describe('The custom field type. Use "clear" to remove the value from the field.'),
          value: z
            .string()
            .optional()
            .describe(
              'The value to set. For text: any string. For number: numeric string (e.g. "42.5"). ' +
                'For checkbox: "true" or "false". For date: ISO 8601 (e.g. "2025-12-31T00:00:00.000Z"). ' +
                'For list: the option ID. Not needed when type is "clear".'
            ),
        },
      },
      async ({ cardId, customFieldId, type, value }) => {
        try {
          if (type !== 'clear' && !value) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: value is required when type is not "clear"',
                },
              ],
              isError: true,
            };
          }

          const result = await this.trelloClient.updateCardCustomField(cardId, customFieldId, {
            type,
            value,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Card history tool
    this.server.registerTool(
      'get_card_history',
      {
        title: 'Get Card History',
        description: 'Get the history/actions of a specific card',
        inputSchema: {
          cardId: z.string().describe('ID of the card to get history for'),
          filter: z
            .string()
            .optional()
            .describe(
              'Optional: Filter actions by type (e.g., "all", "updateCard:idList", "addAttachmentToCard", "commentCard", "updateCard:name", "updateCard:desc", "updateCard:due", "addMemberToCard", "removeMemberFromCard", "addLabelToCard", "removeLabelFromCard")'
            ),
          limit: z
            .number()
            .optional()
            .describe('Optional: Number of actions to fetch (default: all)'),
        },
      },
      async ({ cardId, filter, limit }) => {
        try {
          const history = await this.trelloClient.getCardHistory(cardId, filter, limit);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(history, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Download attachment tool
    this.server.registerTool(
      'download_attachment',
      {
        title: 'Download Attachment',
        description:
          'Download an attachment from a card. To save the file to disk, pass savePath (preferred for non-image files and anything you intend to keep — avoids base64 in context). Omit savePath only to view an image inline.',
        inputSchema: {
          cardId: z.string().describe('ID of the card containing the attachment'),
          attachmentId: z.string().describe('ID of the attachment to download'),
          savePath: z
            .string()
            .optional()
            .describe(
              'Absolute path to save the file to. A directory path uses the attachment\'s own filename. When set, the file is streamed to disk and only metadata is returned.'
            ),
        },
      },
      async ({ cardId, attachmentId, savePath }) => {
        try {
          const result = await this.trelloClient.downloadAttachment(
            cardId,
            attachmentId,
            savePath
          );

          if (result.savedTo) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      fileName: result.fileName,
                      mimeType: result.mimeType,
                      savedTo: result.savedTo,
                      bytes: result.bytes,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          if (result.mimeType.startsWith('image/')) {
            return {
              content: [
                {
                  type: 'image' as const,
                  data: result.data!,
                  mimeType: result.mimeType,
                },
                {
                  type: 'text' as const,
                  text: `Downloaded: ${result.fileName} (${result.mimeType})`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { fileName: result.fileName, mimeType: result.mimeType, data: result.data },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
  }

  private setupSearchTools() {
    this.server.registerTool(
      'search_trello',
      {
        title: 'Search Trello',
        description:
          'Search for cards and boards across your entire Trello workspace using a keyword query. ' +
          'Returns matching cards and boards without needing to know which board or list they are on.',
        inputSchema: {
          query: z.string().describe('Search term to find cards and/or boards'),
          modelTypes: z
            .enum(['cards', 'boards', 'cards,boards'])
            .optional()
            .describe('What to search for: "cards", "boards", or "cards,boards" (default)'),
          idBoards: z
            .string()
            .optional()
            .describe('Comma-separated board IDs to scope the search, or "mine" for your boards'),
          cardsLimit: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe('Max number of cards to return (default 50)'),
          boardsLimit: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe('Max number of boards to return (default 10)'),
          partial: z
            .boolean()
            .optional()
            .describe('If true, enables prefix/partial matching'),
        },
      },
      async ({ query, modelTypes, idBoards, cardsLimit, boardsLimit, partial }) => {
        try {
          const result = await this.trelloClient.searchTrello(query, {
            modelTypes,
            idBoards,
            cardsLimit,
            boardsLimit,
            partial,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          return this.handleError(error);
        }
      }
    );
  }

  private setupHealthEndpoints() {
    // Basic health check endpoint
    this.server.registerTool('get_health', HealthEndpointSchemas.basicHealth, async () => {
      try {
        return await this.healthEndpoints.getBasicHealth();
      } catch (error) {
        return this.handleError(error);
      }
    });

    // Detailed health diagnostic endpoint
    this.server.registerTool(
      'get_health_detailed',
      HealthEndpointSchemas.detailedHealth,
      async () => {
        try {
          return await this.healthEndpoints.getDetailedHealth();
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Metadata consistency check endpoint
    this.server.registerTool(
      'get_health_metadata',
      HealthEndpointSchemas.metadataHealth,
      async () => {
        try {
          return await this.healthEndpoints.getMetadataHealth();
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // Performance metrics endpoint
    this.server.registerTool(
      'get_health_performance',
      HealthEndpointSchemas.performanceHealth,
      async () => {
        try {
          return await this.healthEndpoints.getPerformanceHealth();
        } catch (error) {
          return this.handleError(error);
        }
      }
    );

    // System repair endpoint
    this.server.registerTool('perform_system_repair', HealthEndpointSchemas.repair, async () => {
      try {
        return await this.healthEndpoints.performRepair();
      } catch (error) {
        return this.handleError(error);
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    // Load configuration before starting the server
    await this.trelloClient.loadConfig().catch(() => {
      // Continue with default config if loading fails
    });
    await this.server.connect(transport);
  }
}

const server = new TrelloServer();
server.run().catch(() => {
  // Silently handle errors to avoid interfering with MCP protocol
});
