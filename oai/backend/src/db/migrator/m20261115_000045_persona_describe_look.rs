use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20261115_000045_persona_describe_look"
    }
}

/// "Describe look": a persona's preferred vision model and its custom look prompt
/// (NULL = automatic model / the built-in default prompt).
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Personas::Table)
                    .add_column(ColumnDef::new(Personas::VisionCapability).text().null())
                    .add_column(ColumnDef::new(Personas::LookPrompt).text().null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Personas::Table)
                    .drop_column(Personas::VisionCapability)
                    .drop_column(Personas::LookPrompt)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Personas {
    Table,
    VisionCapability,
    LookPrompt,
}
