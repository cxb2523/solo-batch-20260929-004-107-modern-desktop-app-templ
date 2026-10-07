import { Badge, Group, Text, Tooltip } from '@mantine/core';
import { runtimeConfig } from '../config/runtime';

// 环境角标：把“当前环境名 + 更新端点”直接暴露在界面上，便于核对三态产物。
// 取值唯一来自 src/config/runtime.ts（构建期静态注入），不读取任何运行时回传。
const ENV_COLOR: Record<typeof runtimeConfig.appEnv, string> = {
	dev: 'lime.7',
	staging: 'yellow.7',
	prod: 'red.7',
};

export function EnvironmentBadge() {
	return (
	<Group gap={6} data-testid="env-badge">
		<Tooltip
			label={<Text size="xs" ff="monospace">{runtimeConfig.updateEndpoint}</Text>}
			position="bottom"
			multiline
			w={320}>
			<Badge
				color={ENV_COLOR[runtimeConfig.appEnv]}
				variant="filled"
				radius="sm"
				data-env={runtimeConfig.appEnv}
				data-update-endpoint={runtimeConfig.updateEndpoint}>
				{runtimeConfig.appEnvLabel}
			</Badge>
		</Tooltip>
		<Text
			visibleFrom="lg"
			size="xs"
			ff="monospace"
			c="dimmed"
			maw={280}
			truncate
			data-testid="env-update-endpoint">
			{runtimeConfig.updateEndpoint.replace(/^https?:\/\//, '')}
		</Text>
	</Group>
	);
}
