export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      accounts: {
        Row: {
          account_key: string | null;
          email: string | null;
          id: string;
          note: string | null;
          opened_at: string | null;
          password_source: string;
          product_id: string;
          profile_url: string | null;
          pw_version: number;
          site_id: string;
          status: string;
          username: string | null;
          verification: string | null;
        };
        Insert: {
          account_key?: never;
          email?: string | null;
          id?: string;
          note?: string | null;
          opened_at?: string | null;
          password_source?: string;
          product_id: string;
          profile_url?: string | null;
          pw_version?: number;
          site_id: string;
          status: string;
          username?: string | null;
          verification?: string | null;
        };
        Update: {
          account_key?: never;
          email?: string | null;
          id?: string;
          note?: string | null;
          opened_at?: string | null;
          password_source?: string;
          product_id?: string;
          profile_url?: string | null;
          pw_version?: number;
          site_id?: string;
          status?: string;
          username?: string | null;
          verification?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "accounts_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "v_signup_backlog";
            referencedColumns: ["product_id"];
          },
        ];
      };
      allowed_emails: {
        Row: {
          added_at: string;
          added_by: string | null;
          email: string;
          revoked_at: string | null;
          role: string;
        };
        Insert: {
          added_at?: string;
          added_by?: string | null;
          email: string;
          revoked_at?: string | null;
          role?: string;
        };
        Update: {
          added_at?: string;
          added_by?: string | null;
          email?: string;
          revoked_at?: string | null;
          role?: string;
        };
        Relationships: [];
      };
      attempts: {
        Row: {
          account_key: string;
          dry_run: boolean;
          finished_at: string | null;
          id: number;
          legacy_sqlite_id: number | null;
          note: string | null;
          product_id: string;
          run_id: string | null;
          site_id: string;
          started_at: string;
          status: string;
          terminal: boolean;
        };
        Insert: {
          account_key: string;
          dry_run?: boolean;
          finished_at?: string | null;
          id?: never;
          legacy_sqlite_id?: number | null;
          note?: string | null;
          product_id: string;
          run_id?: string | null;
          site_id: string;
          started_at: string;
          status: string;
          terminal?: boolean;
        };
        Update: {
          account_key?: string;
          dry_run?: boolean;
          finished_at?: string | null;
          id?: never;
          legacy_sqlite_id?: number | null;
          note?: string | null;
          product_id?: string;
          run_id?: string | null;
          site_id?: string;
          started_at?: string;
          status?: string;
          terminal?: boolean;
        };
        Relationships: [];
      };
      panel_settings: {
        Row: {
          key: string;
          value: NonNullable<Json>;
        };
        Insert: {
          key: string;
          value: NonNullable<Json>;
        };
        Update: {
          key?: string;
          value?: NonNullable<Json>;
        };
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          profile: NonNullable<Json>;
          status: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          profile?: NonNullable<Json>;
          status?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          profile?: NonNullable<Json>;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          created_at: string;
          display_name: string | null;
          email: string;
          id: string;
        };
        Insert: {
          created_at?: string;
          display_name?: string | null;
          email: string;
          id: string;
        };
        Update: {
          created_at?: string;
          display_name?: string | null;
          email?: string;
          id?: string;
        };
        Relationships: [];
      };
      scan_progress: {
        Row: {
          finished_at: string | null;
          scanned: number;
          started_at: string | null;
          tab: string;
          total_rows: number;
          updated_at: string;
        };
        Insert: {
          finished_at?: string | null;
          scanned?: number;
          started_at?: string | null;
          tab: string;
          total_rows?: number;
          updated_at?: string;
        };
        Update: {
          finished_at?: string | null;
          scanned?: number;
          started_at?: string | null;
          tab?: string;
          total_rows?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      site_configs: {
        Row: {
          config: Json | null;
          content_hash: string;
          parse_error: string | null;
          risk: string | null;
          signup_url: string | null;
          site_id: string;
          solve_captcha: boolean | null;
          state: string;
          synced_at: string;
          verification_mode: string | null;
        };
        Insert: {
          config?: Json | null;
          content_hash: string;
          parse_error?: string | null;
          risk?: string | null;
          signup_url?: string | null;
          site_id: string;
          solve_captcha?: boolean | null;
          state: string;
          synced_at?: string;
          verification_mode?: string | null;
        };
        Update: {
          config?: Json | null;
          content_hash?: string;
          parse_error?: string | null;
          risk?: string | null;
          signup_url?: string | null;
          site_id?: string;
          solve_captcha?: boolean | null;
          state?: string;
          synced_at?: string;
          verification_mode?: string | null;
        };
        Relationships: [];
      };
      site_discoveries: {
        Row: {
          discovered_at: string | null;
          outcome: Database["public"]["Enums"]["discovery_outcome"];
          reason: string | null;
          signup_url: string | null;
          site_id: string;
          tab: string;
        };
        Insert: {
          discovered_at?: string | null;
          outcome: Database["public"]["Enums"]["discovery_outcome"];
          reason?: string | null;
          signup_url?: string | null;
          site_id: string;
          tab: string;
        };
        Update: {
          discovered_at?: string | null;
          outcome?: Database["public"]["Enums"]["discovery_outcome"];
          reason?: string | null;
          signup_url?: string | null;
          site_id?: string;
          tab?: string;
        };
        Relationships: [];
      };
      site_listings: {
        Row: {
          imported_at: string;
          row_number: number;
          sheet_status: string;
          site_id: string;
          tab: string;
        };
        Insert: {
          imported_at?: string;
          row_number: number;
          sheet_status?: string;
          site_id: string;
          tab: string;
        };
        Update: {
          imported_at?: string;
          row_number?: number;
          sheet_status?: string;
          site_id?: string;
          tab?: string;
        };
        Relationships: [
          {
            foreignKeyName: "site_listings_site_id_fkey";
            columns: ["site_id"];
            isOneToOne: false;
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "site_listings_site_id_fkey";
            columns: ["site_id"];
            isOneToOne: false;
            referencedRelation: "v_site_outcome";
            referencedColumns: ["site_id"];
          },
        ];
      };
      sites: {
        Row: {
          first_seen_at: string;
          id: string;
          name: string | null;
          website: string;
        };
        Insert: {
          first_seen_at?: string;
          id: string;
          name?: string | null;
          website: string;
        };
        Update: {
          first_seen_at?: string;
          id?: string;
          name?: string | null;
          website?: string;
        };
        Relationships: [];
      };
      sync_status: {
        Row: {
          changed_rows: number;
          daily_limit: number;
          id: boolean;
          last_error: string | null;
          last_ok_at: string | null;
          last_run_at: string;
          sheet_read_at: string | null;
          source_host: string | null;
        };
        Insert: {
          changed_rows?: number;
          daily_limit?: number;
          id?: boolean;
          last_error?: string | null;
          last_ok_at?: string | null;
          last_run_at: string;
          sheet_read_at?: string | null;
          source_host?: string | null;
        };
        Update: {
          changed_rows?: number;
          daily_limit?: number;
          id?: boolean;
          last_error?: string | null;
          last_ok_at?: string | null;
          last_run_at?: string;
          sheet_read_at?: string | null;
          source_host?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      v_blocked_pairs: {
        Row: {
          finished_at: string | null;
          note: string | null;
          product_id: string | null;
          site_id: string | null;
          status: string | null;
        };
        Relationships: [];
      };
      v_config_states: {
        Row: {
          configs: number | null;
          state: string | null;
        };
        Relationships: [];
      };
      v_scan_map: {
        Row: {
          outcome: string | null;
          sites: number | null;
          tab: string | null;
        };
        Relationships: [];
      };
      v_signup_backlog: {
        Row: {
          awaiting_move: number | null;
          blocked: number | null;
          opened: number | null;
          product_id: string | null;
          ready: number | null;
          unverified: number | null;
        };
        Relationships: [];
      };
      v_site_outcome: {
        Row: {
          outcome: string | null;
          site_id: string | null;
        };
        Relationships: [];
      };
      v_site_status: {
        Row: {
          config_state: string | null;
          name: string | null;
          outcome: string | null;
          reason: string | null;
          risk: string | null;
          row_number: number | null;
          signup_url: string | null;
          site_id: string | null;
          tab: string | null;
          website: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "site_listings_site_id_fkey";
            columns: ["site_id"];
            isOneToOne: false;
            referencedRelation: "sites";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "site_listings_site_id_fkey";
            columns: ["site_id"];
            isOneToOne: false;
            referencedRelation: "v_site_outcome";
            referencedColumns: ["site_id"];
          },
        ];
      };
      v_unique_outcomes: {
        Row: {
          outcome: string | null;
          sites: number | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      daily_attempts: {
        Args: { days?: number; tz?: string };
        Returns: {
          completed: number;
          day: string;
          dry_runs: number;
          real_attempts: number;
        }[];
      };
      hook_before_user_created: { Args: { event: Json }; Returns: Json };
      is_admin: { Args: Record<PropertyKey, never>; Returns: boolean };
      is_member: { Args: Record<PropertyKey, never>; Returns: boolean };
      real_attempts_today: { Args: { tz?: string }; Returns: number };
    };
    Enums: {
      discovery_outcome:
        | "generated"
        | "no_form"
        | "submit_form"
        | "email_first"
        | "bot_protected"
        | "high_risk"
        | "error"
        | "skipped_existing";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      discovery_outcome: [
        "generated",
        "no_form",
        "submit_form",
        "email_first",
        "bot_protected",
        "high_risk",
        "error",
        "skipped_existing",
      ],
    },
  },
} as const;
