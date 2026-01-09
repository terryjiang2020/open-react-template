import json
import numpy as np
import matplotlib.pyplot as plt
from sklearn.manifold import TSNE
import os

# 路径配置
data_path = os.path.join(os.path.dirname(__file__), '../doc/vectorized-data/vectorized-data.json')
output_img = os.path.join(os.path.dirname(__file__), 'embeddings_2d.png')

# 读取数据
with open(data_path, 'r', encoding='utf-8') as f:
    data = json.load(f)

embeddings = []
labels = []
for item in data:
    embeddings.append(item['embedding'])
    labels.append(item.get('id', ''))

embeddings = np.array(embeddings)

# t-SNE降到二维
tsne = TSNE(n_components=2, random_state=42, perplexity=30, max_iter=1000)
embeddings_2d = tsne.fit_transform(embeddings)

# 绘图
plt.figure(figsize=(16, 12))
# 使用彩色映射，每个点不同色
num_points = embeddings_2d.shape[0]
colors = plt.cm.get_cmap('tab20', num_points)
plt.scatter(embeddings_2d[:, 0], embeddings_2d[:, 1], c=range(num_points), cmap=colors, s=18, alpha=0.85)

# 标注所有点的id（小字体，低alpha）
for i, label in enumerate(labels):
    plt.annotate(label, (embeddings_2d[i, 0], embeddings_2d[i, 1]), fontsize=6, alpha=0.6)

plt.title('2D Visualization of Embeddings (t-SNE, colored & labeled)')
plt.xlabel('Dimension 1')
plt.ylabel('Dimension 2')
plt.tight_layout()
plt.savefig(output_img, dpi=300)
print(f"2D embedding plot saved to {output_img}")
