import * as vscode from "vscode";
import { JobManager } from "../../config";
import { JobInfo } from "../../connection/manager";
import { SelfCodeNode } from "../../views/jobManager/selfCodes/nodes";
import { findPossibleTables } from "../../chat/context";
import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
  ContextSubmenuItem,
  IContextProvider,
  LoadSubmenuItemsArgs,
} from "../../..";

const DB2_SYSTEM_PROMPT = `You are an expert in IBM i, specializing in database features of Db2 for i. Your role is to assist developers in writing and debugging their SQL queries, as well as providing SQL programming advice and best practices.`

const db2ContextProviderDesc: ContextProviderDescription = {
  title: "db2i",
  displayTitle: "Db2i",
  description: "Db2 for i Context Provider",
  type: "normal",
};

/**
 * - Get Existing Db2 connection from vscode
 * - Use connection to build query for database to add additional context
 *
 */
export class db2ContextProvider implements IContextProvider {
  get description(): ContextProviderDescription {
    return db2ContextProviderDesc;
  }

  getCurrentJob(): JobInfo {
    const currentJob: JobInfo = JobManager.getSelection();
    return currentJob;
  }

  private getDefaultSchema = (): string => {
    const currentJob: JobInfo = this.getCurrentJob();
    return currentJob?.job.options.libraries[0] || "QGPL";
  };

  async getSelfCodes(selected: JobInfo): Promise<SelfCodeNode[] | undefined> {
    const current_job = selected.job.id;
    const content = `
    SELECT 
      job_name, 
      user_name, 
      reason_code, 
      logged_time, 
      logged_sqlstate, 
      logged_sqlcode, 
      matches, 
      stmttext, 
      message_text, 
      message_second_level_text,
      program_library, 
      program_name, 
      program_type, 
      module_name, 
      client_applname, 
      client_programid, 
      initial_stack
    FROM 
      qsys2.sql_error_log, 
      LATERAL (
        SELECT * 
        FROM TABLE(SYSTOOLS.SQLCODE_INFO(logged_sqlcode))
      )
    WHERE 
      job_name = '${current_job}'
    ORDER BY 
      logged_time DESC
  `;

    try {
      const result = await selected.job
        .query<SelfCodeNode>(content)
        .execute(10000);
      if (result.success) {
        const data: SelfCodeNode[] = result.data.map((row) => ({
          ...row,
          INITIAL_STACK: JSON.parse(row.INITIAL_STACK as unknown as string),
        }));

        return data;
      }
    } catch (e) {
      vscode.window.showErrorMessage(
        `An error occured fetching SELF code errors, and therefore will be disabled.`
      );
    }
  }

  async getContextItems(
    query: string,
    extras: ContextProviderExtras
  ): Promise<ContextItem[]> {
    const job: JobInfo = this.getCurrentJob();
    const schema = this.getDefaultSchema();
    const fullInput = extras.fullInput;
    const contextItems: ContextItem[] = [];
    try {
      switch (true) {
        case (fullInput.includes(`*SELF`) || query?.includes(`*SELF`)):
          // get current self code errors in job
          // build promt with error information
          // add to contextItems

          if (job) {
            const selfCodes = await this.getSelfCodes(job);

            let prompt = `Db2 for i  self code errors\n`;
            prompt += `Summarize the SELF code errors provided. The SQL Error Logging Facility (SELF) provides a mechanism that can be used to understand when SQL statements are encountering specific SQL errors or warnings. SELF is built into Db2 for i and can be enabled in specific jobs or system wide. Provide additional details about the errors and how to fix them.\n`;
            prompt += `Errors:\n`;
            prompt += JSON.stringify(selfCodes, null, 2);

            contextItems.push({
              name: `${job.name}-self`,
              description: `SELF code errors for ${job.name}`,
              content: prompt,
            });
          }

          return contextItems;
        default:
          // const contextItems: ContextItem[] = [];
          const tableRefs = await findPossibleTables(
            null,
            schema,
            fullInput.split(` `)
          );
          contextItems.push({
            name: `SYSTEM PROMPT`,
            description: `system prompt context`,
            content: DB2_SYSTEM_PROMPT,
          });
          for (const table of Object.keys(tableRefs)) {
            const columnData: TableColumn[] = tableRefs[table];
            const tableSchema =
              columnData.length > 0 ? columnData[0].TABLE_SCHEMA : null;

            // create context item
            let prompt = `Db2 for i schema ${tableSchema} table ${table}\n`;
            prompt += `SYSTEM Prompt`
            prompt += `Column Info: ${JSON.stringify(columnData)}\n\n`;

            contextItems.push({
              name: `${job.name}-${tableSchema}-${table}`,
              description: `Schema and table information or ${table}`,
              content: prompt,
            });
          }

          return contextItems;
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to query Db2i database: ${error}`);
      throw new Error(`Failed to query Db2i database: ${error}`);
    } finally {
    }
  }
  async loadSubmenuItems(
    args: LoadSubmenuItemsArgs
  ): Promise<ContextSubmenuItem[]> {
    return [];
  }
}

export async function registerContinueProvider() {
  const provider = new db2ContextProvider();
  const continueID = `Continue.continue`;
  const continueEx = vscode.extensions.getExtension(continueID);
  const continueAPI = continueEx?.exports;
  continueAPI?.registerCustomContextProvider(provider);
}
