use sea_orm_migration::prelude::*;

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20260731_000030_movie_split_video_capability"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(MovieJobs::Table)
                    .add_column(ColumnDef::new(MovieJobs::Img2VideoCapability).text().null())
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(MovieJobs::Table)
                    .rename_column(MovieJobs::VideoCapability, MovieJobs::Txt2VideoCapability)
                    .to_owned(),
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(
                "UPDATE movie_jobs SET img2video_capability = txt2video_capability \
                 WHERE img2video_capability IS NULL",
            )
            .await
            .map(|_| ())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(MovieJobs::Table)
                    .rename_column(MovieJobs::Txt2VideoCapability, MovieJobs::VideoCapability)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(MovieJobs::Table)
                    .drop_column(MovieJobs::Img2VideoCapability)
                    .to_owned(),
            )
            .await
    }
}

// Explicit idens: the derived snake_case of `Txt2VideoCapability` is
// `txt2_video_capability` (extra underscore after the digit), which would not
// match the `movie_jobs` entity's `txt2video_capability` field.
#[derive(DeriveIden)]
pub enum MovieJobs {
    Table,
    VideoCapability,
    #[sea_orm(iden = "txt2video_capability")]
    Txt2VideoCapability,
    #[sea_orm(iden = "img2video_capability")]
    Img2VideoCapability,
}
