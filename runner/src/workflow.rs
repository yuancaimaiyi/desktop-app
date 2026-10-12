use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkflowInput {
    #[serde(rename = "type")]
    pub io_type: String,
    #[serde(default)]
    pub ext: Vec<String>,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkflowNode {
    pub id: String,
    pub operator: String,
    /// Specific operator version to use. None = use latest registered version.
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub params: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkflowEdge {
    pub from_node: String,
    pub from_output: String,
    pub to_node: String,
    pub to_input: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkflowInputTo {
    pub node: String,
    pub input: String,
}

/// Supports either a single input_to (back-compat) or an array of them.
/// Serde-level untagged union so both JSON shapes parse to the same enum.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum WorkflowInputToSpec {
    Single(WorkflowInputTo),
    Many(Vec<WorkflowInputTo>),
}

impl WorkflowInputToSpec {
    pub fn as_slice(&self) -> &[WorkflowInputTo] {
        match self {
            WorkflowInputToSpec::Single(s) => std::slice::from_ref(s),
            WorkflowInputToSpec::Many(v) => v.as_slice(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub input: WorkflowInput,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    pub workflow_input_to: WorkflowInputToSpec,
}

impl Workflow {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let s = std::fs::read_to_string(path)?;
        let wf: Self = serde_json::from_str(&s)?;
        Ok(wf)
    }

    pub fn topo_sorted_nodes(&self) -> Vec<&WorkflowNode> {
        // Build adjacency: node_id -> list of node_ids that depend on it
        let mut in_degree: HashMap<&str, usize> = HashMap::new();
        let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();

        for node in &self.nodes {
            in_degree.entry(&node.id).or_insert(0);
        }
        for edge in &self.edges {
            *in_degree.entry(&edge.to_node).or_insert(0) += 1;
            dependents
                .entry(&edge.from_node)
                .or_default()
                .push(&edge.to_node);
        }

        let mut queue: Vec<&str> = in_degree
            .iter()
            .filter(|(_, &d)| d == 0)
            .map(|(id, _)| *id)
            .collect();
        queue.sort();
        let mut result = Vec::new();

        while let Some(nid) = queue.first().copied() {
            queue.remove(0);
            if let Some(node) = self.nodes.iter().find(|n| n.id == nid) {
                result.push(node);
            }
            if let Some(deps) = dependents.get(nid) {
                for dep in deps {
                    let cnt = in_degree.get_mut(dep).unwrap();
                    *cnt -= 1;
                    if *cnt == 0 {
                        queue.push(dep);
                        queue.sort();
                    }
                }
            }
        }
        result
    }
}
