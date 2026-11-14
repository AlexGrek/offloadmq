use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "langgraph_jobs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
    pub status: String,
    pub prompt: String,
    pub capability: String,
    pub request_json: String,
    pub result_json: Option<String>,
    pub artifacts_json: String,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub offload_bucket_uid: Option<String>,
    pub stage: Option<String>,
    pub error: Option<String>,
}
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}
impl ActiveModelBehavior for ActiveModel {}
