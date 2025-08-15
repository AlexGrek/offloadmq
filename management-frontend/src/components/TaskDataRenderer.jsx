import React from 'react';

const styles = {
  container: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    padding: '20px',
    backgroundColor: '#f0f2f5',
    color: '#333',
  },
  header: {
    fontSize: '24px',
    fontWeight: '600',
    borderBottom: '2px solid #e0e0e0',
    paddingBottom: '10px',
    marginBottom: '20px',
  },
  category: {
    marginBottom: '30px',
  },
  categoryTitle: {
    fontSize: '20px',
    fontWeight: '500',
    textTransform: 'capitalize',
    marginBottom: '15px',
    color: '#1a1a1a',
  },
  assignmentType: {
    marginLeft: '20px',
  },
  assignmentTitle: {
    fontSize: '16px',
    fontWeight: 'bold',
    textTransform: 'capitalize',
    color: '#555',
    marginBottom: '10px',
  },
  taskCard: {
    backgroundColor: '#ffffff',
    border: '1px solid #d9d9d9',
    borderRadius: '8px',
    padding: '15px',
    marginBottom: '10px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
    transition: 'box-shadow 0.3s ease',
  },
  taskCardHover: {
    boxShadow: '0 4px 8px rgba(0,0,0,0.1)',
  },
  taskDetail: {
    marginBottom: '8px',
    fontSize: '14px',
    wordBreak: 'break-all',
  },
  taskLabel: {
    fontWeight: '600',
    marginRight: '8px',
    color: '#444',
  },
  noTasks: {
    fontStyle: 'italic',
    color: '#888',
    marginLeft: '20px',
  }
};

const TaskCard = ({ task }) => {
  const [isHovered, setIsHovered] = React.useState(false);
  const { id, data, createdAt } = task;

  const formatDate = (dateString) => {
    const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    return new Date(dateString).toLocaleDateString(undefined, options);
  };

  return (
    <div
      style={{...styles.taskCard, ...(isHovered ? styles.taskCardHover : {})}}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div style={styles.taskDetail}><span style={styles.taskLabel}>ID:</span>{id.id}</div>
      <div style={styles.taskDetail}><span style={styles.taskLabel}>Capability:</span>{id.cap}</div>
      <div style={styles.taskDetail}><span style={styles.taskLabel}>Payload:</span>{data.payload}</div>
      <div style={styles.taskDetail}><span style={styles.taskLabel}>API Key:</span>{data.apiKey}</div>
      <div style={styles.taskDetail}><span style={styles.taskLabel}>Urgent:</span>{data.urgent ? 'Yes' : 'No'}</div>
      <div style={styles.taskDetail}><span style={styles.taskLabel}>Restartable:</span>{data.restartable ? 'Yes' : 'No'}</div>
      <div style={styles.taskDetail}><span style={styles.taskLabel}>Created At:</span>{formatDate(createdAt)}</div>
    </div>
  );
};

const AssignmentSection = ({ title, tasks }) => (
  <div style={styles.assignmentType}>
    <h4 style={styles.assignmentTitle}>{title}</h4>
    {tasks.length > 0 ? (
      tasks.map(task => <TaskCard key={task.id.id} task={task} />)
    ) : (
      <p style={styles.noTasks}>No tasks found.</p>
    )}
  </div>
);

const TaskDataRenderer = ({ data }) => {
  if (!data) {
    return <div style={styles.container}>No data to display.</div>;
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.header}>Task Dashboard</h1>
      {Object.keys(data).map(categoryKey => (
        <div key={categoryKey} style={styles.category}>
          <h2 style={styles.categoryTitle}>{categoryKey}</h2>
          {Object.keys(data[categoryKey]).map(assignmentKey => (
            <AssignmentSection
              key={assignmentKey}
              title={assignmentKey}
              tasks={data[categoryKey][assignmentKey]}
            />
          ))}
        </div>
      ))}
    </div>
  );
};

export default TaskDataRenderer;